# frozen_string_literal: true

# Shared, dependency-free release logic for the generated Android Fastlane lanes.
# External services are reached only through FastlaneAdapter after preflight succeeds.
require "base64"
require "digest"
require "fileutils"
require "json"
require "open3"
require "securerandom"
require "tempfile"
require "tmpdir"

module FlutterPlayStoreRelease
  MAX_VERSION_CODE = 2_100_000_000
  VERSION_NAME_PATTERN = /\Av?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?\z/.freeze
  DEFAULT_PLAY_TRACKS = %w[internal alpha beta production].freeze
  RESULT_SCHEMA_VERSION = 1

  class ReleaseError < StandardError; end
  class ConfigurationError < ReleaseError; end
  class PreflightError < ConfigurationError; end
  class ArtifactError < ReleaseError; end
  class ExternalActionError < ReleaseError; end
  class FirstReleaseRequiredError < ReleaseError; end
  class PartialSuccessError < ReleaseError; end

  class << self
    def normalize_version_name(raw)
      value = raw.to_s.strip
      match = VERSION_NAME_PATTERN.match(value)
      raise ConfigurationError, "version name must match v?MAJOR.MINOR.PATCH with an optional dot-separated prerelease" unless match

      core = [match[1], match[2], match[3]].join(".")
      match[4] ? "#{core}-#{match[4]}" : core
    end

    def resolve_version_name(option:, env:, exact_head_tags:, pubspec:)
      return normalize_version_name(option) unless blank?(option)
      return normalize_version_name(env) unless blank?(env)

      tags = Array(exact_head_tags).map { |tag| tag.to_s.strip }.reject(&:empty?)
      unless tags.empty?
        normalized = tags.map do |tag|
          normalize_version_name(tag)
        rescue ConfigurationError
          raise ConfigurationError, "exact HEAD tags contain an unsupported or ambiguous version tag"
        end
        unique = normalized.uniq
        raise ConfigurationError, "exact HEAD tags resolve to conflicting version names" unless unique.length == 1
        return unique.first
      end

      pubspec_value = pubspec.to_s.strip
      pubspec_value = pubspec_value.split("+", 2).first
      normalize_version_name(pubspec_value)
    end

    def validate_version_code(raw, source:)
      value = raw.to_s.strip
      unless value.match?(/\A[0-9]+\z/)
        raise ConfigurationError, "#{source} must be a positive integer version code"
      end
      number = Integer(value, 10)
      unless number.between?(1, MAX_VERSION_CODE)
        raise ConfigurationError, "#{source} must be between 1 and #{MAX_VERSION_CODE}"
      end
      number
    rescue ArgumentError
      raise ConfigurationError, "#{source} must be a positive integer version code"
    end

    # Returns the next active-track code. Google Play does not expose an
    # authoritative allocator for every code ever used, so callers must serialize
    # selection and upload and handle a reuse rejection explicitly.
    def next_active_track_code(track_names:, fetch_track_codes:)
      tracks = ordered_unique(Array(track_names).map { |track| track.to_s.strip }.reject(&:empty?))
      raise ConfigurationError, "at least one Play track is required" if tracks.empty?

      codes = []
      tracks.each do |track|
        begin
          response = fetch_track_codes.call(track)
        rescue ReleaseError
          raise
        rescue StandardError => error
          raise ExternalActionError, "could not query Play track #{track}: #{classify_play_failure(error)}"
        end
        unless response.is_a?(Array)
          raise ExternalActionError, "Play track #{track} returned an invalid version-code response"
        end
        response.each do |raw_code|
          codes << validate_version_code(raw_code, source: "Play track #{track} version code")
        end
      end

      if codes.empty?
        raise FirstReleaseRequiredError,
          "all configured Play tracks are empty; complete the first-release/manual-bootstrap checklist"
      end
      maximum = codes.max
      if maximum >= MAX_VERSION_CODE
        raise ConfigurationError, "the next active-track code would exceed #{MAX_VERSION_CODE}"
      end
      maximum + 1
    end

    def distribution_steps(target:, firebase_enabled:)
      normalized = target.to_s.strip
      if normalized.empty?
        return truthy?(firebase_enabled) ? %w[play-store firebase] : ["play-store"]
      end
      case normalized
      when "play-store" then ["play-store"]
      when "firebase" then ["firebase"]
      when "both" then %w[play-store firebase]
      else
        raise ConfigurationError, "DISTRIBUTION_TARGET must be play-store, firebase, or both"
      end
    end

    def locate_fresh_artifact(project_root:, build_started_at:, prior_outputs:, flavor:, artifact_type:)
      root = canonical_directory(project_root, "project root")
      type = normalize_artifact_type(artifact_type)
      output_root = File.join(root, "build", "app", "outputs")
      prior = Array(prior_outputs).map do |path|
        expanded = File.expand_path(path.to_s)
        File.exist?(expanded) ? File.realpath(expanded) : expanded
      end
      started_at = build_started_at.respond_to?(:to_f) ? build_started_at.to_f : Float(build_started_at)
      selected_flavor = present(flavor)

      fresh = artifact_inventory(output_root, type).reject do |entry|
        prior.include?(File.realpath(entry[:path]))
      end.select do |entry|
        File.mtime(entry[:path]).to_f >= started_at
      end
      matching = fresh.select do |entry|
        entry[:state] == :variant && entry[:flavor] == selected_flavor && File.size(entry[:path]).positive?
      end
      if fresh.length != 1 || matching.length != 1
        raise ArtifactError,
          "expected exactly one fresh #{type} artifact for the selected variant; found #{matching.length}"
      end
      File.realpath(matching.first[:path])
    rescue Errno::ENOENT, Errno::ENOTDIR, ArgumentError => error
      raise ArtifactError, "could not validate the requested build artifact: #{error.class}"
    end

    def resolve_secret(path_value:, base64_value:, default_path:, label:, temp_root:)
      root = canonical_directory(temp_root, "owned secret root")
      ensure_private_directory!(root)

      unless blank?(path_value)
        return { path: canonical_secret_file(path_value, label), owned: false, label: label.to_s }
      end

      unless blank?(base64_value)
        begin
          decoded = Base64.strict_decode64(base64_value.to_s)
        rescue ArgumentError
          raise ConfigurationError, "#{label} Base64 input is invalid"
        end
        raise ConfigurationError, "#{label} Base64 input decoded to an empty file" if decoded.empty?

        filename = "#{safe_label(label)}-#{SecureRandom.hex(12)}"
        path = File.join(root, filename)
        File.open(path, File::WRONLY | File::CREAT | File::EXCL, 0o600) do |file|
          file.binmode
          file.write(decoded)
          file.flush
          file.fsync
        end
        File.chmod(0o600, path)
        return { path: path, owned: true, label: label.to_s, root: root }
      end

      unless blank?(default_path)
        return { path: canonical_secret_file(default_path, label), owned: false, label: label.to_s }
      end

      raise ConfigurationError, "#{label} is required"
    end

    def java_properties_escape(value, label:)
      string = value.to_s
      escaped = +""
      leading = true
      string.each_codepoint do |codepoint|
        if codepoint.zero? || codepoint < 0x20 || codepoint == 0x7f
          raise ConfigurationError, "#{label} contains a prohibited control character"
        end
        character = codepoint.chr(Encoding::UTF_8)
        if character == " " && leading
          escaped << "\\ "
        elsif character == "\\"
          escaped << "\\\\"
        elsif "=:#!".include?(character)
          escaped << "\\#{character}"
        elsif codepoint > 0x7e
          append_java_unicode_escape(escaped, codepoint)
        else
          escaped << character
        end
        leading = false unless character == " "
      end
      escaped
    end

    def write_key_properties(path:, keystore_path:, store_password:, key_alias:, key_password:)
      output = File.expand_path(path.to_s)
      key_path = canonical_secret_file(keystore_path, "Android keystore")
      FileUtils.mkdir_p(File.dirname(output), mode: 0o700)
      raise ConfigurationError, "generated key properties path already exists" if File.exist?(output) || File.symlink?(output)

      lines = {
        "storeFile" => key_path,
        "storePassword" => store_password,
        "keyAlias" => key_alias,
        "keyPassword" => key_password
      }.map do |name, value|
        raise ConfigurationError, "#{name} is required" if blank?(value)
        "#{name}=#{java_properties_escape(value, label: name)}"
      end
      File.open(output, File::WRONLY | File::CREAT | File::EXCL, 0o600) do |file|
        file.write(lines.join("\n"))
        file.write("\n")
        file.flush
        file.fsync
      end
      File.chmod(0o600, output)
      output
    end

    def cleanup_owned_secrets(secret_records)
      Array(secret_records).reverse_each do |record|
        next unless record.is_a?(Hash) && record[:owned]
        path = record[:path].to_s
        root = record[:root].to_s
        next if path.empty? || root.empty? || File.symlink?(path) || File.symlink?(root)
        expanded_root = File.realpath(root)
        next unless File.dirname(File.expand_path(path)) == expanded_root
        File.unlink(path) if File.file?(path)
      rescue Errno::ENOENT
        nil
      end
    end

    def slack_payload(repository:, version:, track:, result:, run_url:, source_url:)
      JSON.generate(
        "repository" => repository.to_s,
        "version" => version.to_s,
        "track" => track.to_s,
        "result" => result.to_s,
        "run_url" => run_url.to_s,
        "source_url" => source_url.to_s
      )
    end

    def doctor(env:, target:, context:, actions:, project_root:)
      steps = distribution_steps(target: target, firebase_enabled: env["ENABLE_FIREBASE_APP_DISTRIBUTION"])
      deploy = context.to_s == "deploy"
      report = []
      ruby_version = actions.respond_to?(:runtime_ruby_version) ? actions.runtime_ruby_version : RUBY_VERSION
      ruby_ready = supported_ruby_version?(ruby_version)
      report << doctor_entry(ruby_ready ? "PASS" : (deploy ? "FAIL" : "WARN"),
        ruby_ready ? "Ruby #{ruby_version} satisfies >= 3.2 and < 4.0" : "Ruby >= 3.2 and < 4.0 is required")
      flutter_ready = actions.respond_to?(:tool_available?) && actions.tool_available?("flutter")
      report << doctor_entry(flutter_ready ? "PASS" : (deploy ? "FAIL" : "WARN"),
        flutter_ready ? "Flutter is available" : "Flutter is not available on PATH")
      files_ready = generated_fastlane_files_ready?(project_root)
      report << doctor_entry(files_ready ? "PASS" : (deploy ? "FAIL" : "WARN"),
        files_ready ? "Pinned Fastlane files are present" : "Pinned Fastlane files are incomplete")
      build_runner = pubspec_has_build_runner?(project_root)
      report << doctor_entry("PASS", build_runner ? "build_runner is configured" : "build_runner is not configured")
      report << doctor_entry("PASS", "APP_PACKAGE_NAME is configured") unless blank?(env["APP_PACKAGE_NAME"])
      report << doctor_entry(deploy ? "FAIL" : "WARN", "APP_PACKAGE_NAME is not configured") if blank?(env["APP_PACKAGE_NAME"])

      workspace_signing = File.join(project_root, "android", "key.properties")
      ci = truthy?(env["CI"]) || truthy?(env["GITHUB_ACTIONS"])
      signing_ready = if ci && (File.exist?(workspace_signing) || File.symlink?(workspace_signing))
        false
      elsif !blank?(env["ANDROID_KEY_PROPERTIES_PATH"])
        valid_key_properties_override?(env["ANDROID_KEY_PROPERTIES_PATH"])
      else
        signing_inputs_complete?(env) || (!ci && local_key_properties_complete?(project_root))
      end
      report << doctor_entry(signing_ready ? "PASS" : (deploy ? "FAIL" : "WARN"),
        signing_ready ? "Android release signing input is available" : "Android release signing input is incomplete")

      if steps.include?("play-store")
        track = env.fetch("PLAY_STORE_TRACK", "internal").to_s
        track_ready = track.match?(/\A[A-Za-z0-9._-]+\z/)
        report << doctor_entry(track_ready ? "PASS" : (deploy ? "FAIL" : "WARN"),
          track_ready ? "Play track is configured" : "Play track contains unsupported characters")
        play_ready = credential_input_present?(env, "GOOGLE_PLAY_SERVICE_ACCOUNT_JSON", project_root,
          "android/fastlane/google-play-service-account.json")
        report << doctor_entry(play_ready ? "PASS" : (deploy ? "FAIL" : "WARN"),
          play_ready ? "Google Play credentials are configured" : "Google Play credentials are not configured")
      end
      if steps.include?("firebase")
        firebase_ready = !blank?(env["FIREBASE_APP_ID"]) &&
          credential_input_present?(env, "FIREBASE_SERVICE_ACCOUNT_JSON", project_root,
            "android/fastlane/firebase-service-account.json")
        report << doctor_entry(firebase_ready ? "PASS" : (deploy ? "FAIL" : "WARN"),
          firebase_ready ? "Firebase credentials are configured" : "Firebase credentials are not configured")
      end

      report.each { |entry| actions.log(entry[:level].downcase.to_sym, "#{entry[:level]}: #{entry[:message]}") if actions.respond_to?(:log) }
      if deploy && report.any? { |entry| entry[:level] == "FAIL" }
        raise PreflightError, "deploy preflight failed before any network action"
      end
      report
    end

    def release(options:, env:, actions:, project_root:)
      records = []
      temp_root = nil
      environment = {}
      normalized_options = {}
      target = nil
      artifact_type = nil
      version_name = nil
      artifact_path = nil
      successful = []
      failed_destination = nil
      work_error = nil
      retry_identity = nil

      begin
        begin
          normalized_options = symbolize_keys(options || {})
          environment = stringify_keys(env || {})
          explicit_target = present(normalized_options[:distribution_target])
          if explicit_target.nil?
            ambient_target = present(environment["DISTRIBUTION_TARGET"])
            if !ambient_target.nil? && ambient_target != "play-store"
              raise ConfigurationError,
                "Firebase or dual delivery must be selected by an explicit lane option, not ambient DISTRIBUTION_TARGET"
            end
            if truthy?(environment["ENABLE_FIREBASE_APP_DISTRIBUTION"])
              raise ConfigurationError,
                "ambient ENABLE_FIREBASE_APP_DISTRIBUTION cannot expand an authorized Play release"
            end
            explicit_target = "play-store"
          end
          steps = distribution_steps(
            target: explicit_target,
            firebase_enabled: false
          )
          target = steps == %w[play-store firebase] ? "both" : steps.first
          if target == "both" && !confirmed?(environment["CONFIRM_DUAL_DELIVERY"])
            raise ConfigurationError,
              "dual delivery requires explicit distribution_target:both and CONFIRM_DUAL_DELIVERY=true"
          end
          apply_authorized_release_policy!(normalized_options, environment, steps)
          retry_identity = validate_retry_reconciliation!(normalized_options, environment, target)
          artifact_type = release_artifact_type(steps, environment)
          validate_release_policy!(steps, environment, artifact_type)
          root = canonical_directory(project_root, "project root")
          doctor(env: environment, target: target, context: "deploy", actions: actions, project_root: root)

          temp_root = Dir.mktmpdir("toris-flutter-play-store-release-")
          File.chmod(0o700, temp_root)
          credentials = prepare_credentials(
            steps: steps, env: environment, project_root: root,
            temp_root: temp_root, records: records
          )
          signing_environment = prepare_signing(
            env: environment, project_root: root, temp_root: temp_root,
            records: records
          )

          actions.prepare(**prepare_configuration(environment))
          pubspec_name, pubspec_code = read_pubspec_version(root)
          exact_tags = if blank?(normalized_options[:version_name]) && blank?(environment["VERSION_NAME"])
            actions.exact_head_tags
          else
            []
          end
          version_name = resolve_version_name(
            option: normalized_options[:version_name], env: environment["VERSION_NAME"],
            exact_head_tags: exact_tags, pubspec: pubspec_name
          )

          flavor = present(normalized_options[:flavor] || environment["FLUTTER_FLAVOR"])
          target_file = present(normalized_options[:target] || environment["RELEASE_DART_TARGET"]) || "lib/main.dart"
          release_id = actions.release_application_id(flavor: flavor)
          validate_package_name!(environment.fetch("APP_PACKAGE_NAME"), release_id)
          validate_firebase_mapping!(environment, actions, flavor: flavor) if steps.include?("firebase")
          version_code = if steps.include?("play-store")
            resolve_play_version_code(steps: steps, env: environment, actions: actions,
              json_key: credentials.fetch(:play).fetch(:path), package_name: environment.fetch("APP_PACKAGE_NAME"))
          else
            resolve_local_version_code(environment, pubspec_code, actions)
          end
          if retry_identity && version_code != retry_identity.fetch(:version_code)
            raise ConfigurationError,
              "allocated version code does not match the reconciled unknown upload"
          end

          artifact_path = build_once(
            project_root: root, artifact_type: artifact_type, version_name: version_name,
            version_code: version_code, flavor: flavor, target: target_file,
            environment: signing_environment, actions: actions
          )
          if retry_identity && Digest::SHA256.file(artifact_path).hexdigest != retry_identity.fetch(:artifact_sha256)
            raise ConfigurationError,
              "built artifact SHA-256 does not match the reconciled unknown upload"
          end

          if steps.include?("play-store")
            begin
              upload_play_store(
                env: environment, actions: actions, credential: credentials.fetch(:play),
                artifact_path: artifact_path, version_name: version_name
              )
              successful << "play-store"
            rescue StandardError => error
              failed_destination = "play-store"
              raise error
            end
          end

          if steps.include?("firebase")
            begin
              upload_firebase(
                env: environment, actions: actions, credential: credentials.fetch(:firebase),
                artifact_path: artifact_path, artifact_type: artifact_type,
                version_name: version_name, version_code: version_code
              )
              successful << "firebase"
            rescue StandardError => error
              failed_destination = "firebase"
              raise error
            end
          end
        rescue StandardError => error
          work_error = error
        end

        if work_error
          partial = successful.include?("play-store") && failed_destination == "firebase"
          status = partial ? "PARTIAL_SUCCESS" : "FAILURE"
          message = partial ?
            "Play upload succeeded, but Firebase distribution failed; Play was not rolled back." :
            "Release failed before all requested destinations completed."
          result = result_payload(
            status: status, target: target, version: version_name,
            track: environment.fetch("PLAY_STORE_TRACK", "internal"),
            artifact_type: artifact_type, artifact_path: artifact_path,
            successful: successful, failed_destination: failed_destination,
            message: message
          )
          write_result_if_requested(environment, result, actions, preserve: work_error)
          log_result(actions, result, preserve: work_error)
          notify_if_requested(environment, actions, result)
          if partial
            raise PartialSuccessError, "PARTIAL_SUCCESS: #{message}"
          end
          raise work_error
        end

        result = result_payload(
          status: "SUCCESS", target: target, version: version_name,
          track: environment.fetch("PLAY_STORE_TRACK", "internal"),
          artifact_type: artifact_type, artifact_path: artifact_path,
          successful: successful, failed_destination: nil,
          message: "Release completed successfully."
        )
        write_result_if_requested(environment, result, actions)
        log_result(actions, result)
        notify_if_requested(environment, actions, result)
        result
      ensure
        cleanup_owned_secrets(records)
        FileUtils.remove_entry_secure(temp_root) if temp_root && File.directory?(temp_root)
      end
    end

    def prepare_only(env:, actions:)
      actions.prepare(**prepare_configuration(stringify_keys(env || {})))
    end

    def build_only(options:, env:, actions:, project_root:)
      options = symbolize_keys(options || {})
      environment = stringify_keys(env || {})
      root = canonical_directory(project_root, "project root")
      doctor(env: environment, target: "play-store", context: "build", actions: actions, project_root: root)
      records = []
      temp_root = Dir.mktmpdir("flutter-play-store-build-")
      File.chmod(0o700, temp_root)
      begin
        signing_environment = prepare_signing(env: environment, project_root: root,
          temp_root: temp_root, records: records)
        actions.prepare(**prepare_configuration(environment))
        pubspec_name, pubspec_code = read_pubspec_version(root)
        exact_tags = if blank?(options[:version_name]) && blank?(environment["VERSION_NAME"])
          actions.exact_head_tags
        else
          []
        end
        version_name = resolve_version_name(option: options[:version_name], env: environment["VERSION_NAME"],
          exact_head_tags: exact_tags, pubspec: pubspec_name)
        version_code = resolve_local_version_code(environment, pubspec_code, actions)
        build_once(project_root: root, artifact_type: "AAB", version_name: version_name,
          version_code: version_code, flavor: present(options[:flavor] || environment["FLUTTER_FLAVOR"]),
          target: present(options[:target] || environment["RELEASE_DART_TARGET"]) || "lib/main.dart",
          environment: signing_environment, actions: actions)
      ensure
        cleanup_owned_secrets(records)
        FileUtils.remove_entry_secure(temp_root) if temp_root && File.directory?(temp_root)
      end
    end

    def execute_fastlane_lane(lane, options, dsl)
      adapter = FastlaneAdapter.new(dsl)
      project_root = adapter.project_root
      case lane.to_sym
      when :doctor
        doctor(env: ENV.to_h, target: ENV["DISTRIBUTION_TARGET"], context: "doctor",
          actions: adapter, project_root: project_root)
      when :prepare
        prepare_only(env: ENV.to_h, actions: adapter)
      when :build
        build_only(options: options, env: ENV.to_h, actions: adapter, project_root: project_root)
      when :release
        release(options: options, env: ENV.to_h, actions: adapter, project_root: project_root)
      else
        raise ConfigurationError, "unknown Fastlane lane: #{lane}"
      end
    rescue ReleaseError => error
      adapter.fail!(error.message)
    end

    def handle_fastlane_error(lane, exception, _options = nil)
      classification = if exception.is_a?(PartialSuccessError) || exception.message.to_s.start_with?("PARTIAL_SUCCESS:")
        "PARTIAL_SUCCESS"
      else
        "FAILURE"
      end
      message = "#{classification}: Android lane #{lane} terminated"
      if defined?(FastlaneCore::UI)
        FastlaneCore::UI.error(message)
      else
        warn(message)
      end
    end

    private

    def blank?(value)
      value.nil? || value.to_s.strip.empty?
    end

    def present(value)
      blank?(value) ? nil : value.to_s.strip
    end

    def truthy?(value)
      %w[1 true yes on].include?(value.to_s.strip.downcase)
    end

    def confirmed?(value)
      value.is_a?(String) && value == "true"
    end

    def ordered_unique(values)
      values.each_with_object([]) { |value, result| result << value unless result.include?(value) }
    end

    def stringify_keys(hash)
      hash.each_with_object({}) { |(key, value), result| result[key.to_s] = value }
    end

    def symbolize_keys(hash)
      hash.each_with_object({}) { |(key, value), result| result[key.to_sym] = value }
    end

    def canonical_directory(path, label)
      expanded = File.expand_path(path.to_s)
      unless File.directory?(expanded) && !File.symlink?(expanded)
        raise ConfigurationError, "#{label} is not a safe directory"
      end
      File.realpath(expanded)
    end

    def ensure_private_directory!(path)
      mode = File.stat(path).mode & 0o777
      raise ConfigurationError, "owned secret root must use mode 0700" unless mode == 0o700
    end

    def canonical_secret_file(path, label)
      expanded = File.expand_path(path.to_s)
      unless safe_regular_file?(expanded) && File.size(expanded).positive?
        raise ConfigurationError, "#{label} path must name a nonempty regular file"
      end
      File.realpath(expanded)
    end

    def safe_regular_file?(path)
      File.file?(path) && !File.symlink?(path)
    rescue Errno::ENOENT, Errno::ENOTDIR
      false
    end

    def safe_label(label)
      value = label.to_s.downcase.gsub(/[^a-z0-9]+/, "-").sub(/\A-+/, "").sub(/-+\z/, "")
      value.empty? ? "secret" : value
    end

    def append_java_unicode_escape(output, codepoint)
      if codepoint <= 0xffff
        output << format("\\u%04x", codepoint)
      else
        scalar = codepoint - 0x10000
        output << format("\\u%04x\\u%04x", 0xd800 + (scalar >> 10), 0xdc00 + (scalar & 0x3ff))
      end
    end

    def normalize_artifact_type(value)
      type = value.to_s.upcase
      raise ConfigurationError, "artifact type must be AAB or APK" unless %w[AAB APK].include?(type)
      type
    end

    def artifact_inventory(output_root, type)
      patterns = if type == "AAB"
        [File.join(output_root, "bundle", "**", "*.aab")]
      else
        [
          File.join(output_root, "apk", "**", "*.apk"),
          File.join(output_root, "flutter-apk", "*.apk")
        ]
      end
      patterns.flat_map { |pattern| Dir.glob(pattern) }.uniq.sort.map do |path|
        next nil unless safe_regular_file?(path)
        classification = classify_artifact_path(path, output_root, type)
        { path: path, state: classification[:state], flavor: classification[:flavor] }
      end.compact
    end

    def classify_artifact_path(path, output_root, type)
      relative = path.sub(/\A#{Regexp.escape(output_root)}#{Regexp.escape(File::SEPARATOR)}/, "")
      parts = relative.split(File::SEPARATOR)
      type == "AAB" ? classify_aab_parts(parts) : classify_apk_parts(parts)
    end

    def classify_aab_parts(parts)
      return { state: :ambiguous, flavor: nil } unless parts.length == 3 && parts[0] == "bundle"
      variant = parts[1]
      filename = parts[2]
      if variant == "release"
        return { state: :variant, flavor: nil } if %w[app-release.aab app.aab].include?(filename)
        return { state: :ambiguous, flavor: nil }
      end
      match = variant.match(/\A(.+)Release\z/)
      return { state: :ambiguous, flavor: nil } unless match
      flavor = match[1]
      accepted = ["app-#{flavor}-release.aab", "app-release.aab", "app.aab"]
      accepted.include?(filename) ? { state: :variant, flavor: flavor } : { state: :ambiguous, flavor: nil }
    end

    def classify_apk_parts(parts)
      if parts.length == 2 && parts[0] == "flutter-apk"
        return { state: :variant, flavor: nil } if parts[1] == "app-release.apk"
        match = parts[1].match(/\Aapp-(.+)-release\.apk\z/)
        return match ? { state: :variant, flavor: match[1] } : { state: :ambiguous, flavor: nil }
      end
      return { state: :ambiguous, flavor: nil } unless parts[0] == "apk"
      if parts.length == 3 && parts[1] == "release"
        return parts[2] == "app-release.apk" ?
          { state: :variant, flavor: nil } : { state: :ambiguous, flavor: nil }
      end
      if parts.length == 4 && parts[2] == "release"
        flavor = parts[1]
        accepted = ["app-#{flavor}-release.apk", "app-release.apk"]
        return accepted.include?(parts[3]) ?
          { state: :variant, flavor: flavor } : { state: :ambiguous, flavor: nil }
      end
      if parts.length == 3 && (match = parts[1].match(/\A(.+)Release\z/))
        flavor = match[1]
        accepted = ["app-#{flavor}-release.apk", "app-release.apk", "app.apk"]
        return accepted.include?(parts[2]) ?
          { state: :variant, flavor: flavor } : { state: :ambiguous, flavor: nil }
      end
      { state: :ambiguous, flavor: nil }
    end

    def doctor_entry(level, message)
      { level: level, message: message }
    end

    def credential_input_present?(env, prefix, project_root, default_relative)
      !blank?(env["#{prefix}_PATH"]) || !blank?(env["#{prefix}_BASE64"]) ||
        safe_regular_file?(File.join(project_root, default_relative))
    end

    def signing_inputs_complete?(env)
      keystore = !blank?(env["ANDROID_KEYSTORE_PATH"]) || !blank?(env["ANDROID_KEYSTORE_BASE64"])
      keystore && %w[ANDROID_KEYSTORE_PASSWORD ANDROID_KEY_ALIAS ANDROID_KEY_PASSWORD].all? do |name|
        !blank?(env[name])
      end
    end

    def supported_ruby_version?(value)
      version = Gem::Version.new(value.to_s)
      version >= Gem::Version.new("3.2") && version < Gem::Version.new("4.0")
    rescue ArgumentError
      false
    end

    def generated_fastlane_files_ready?(project_root)
      required = %w[
        android/Gemfile
        android/Gemfile.lock
        android/fastlane/Fastfile
        android/fastlane/Pluginfile
        android/fastlane/lib/flutter_play_store_release.rb
      ]
      return false unless required.all? { |relative| safe_regular_file?(File.join(project_root, relative)) }
      gemfile = File.read(File.join(project_root, "android", "Gemfile"))
      plugin = File.read(File.join(project_root, "android", "fastlane", "Pluginfile"))
      lock = File.read(File.join(project_root, "android", "Gemfile.lock"))
      gemfile.include?('gem "fastlane", "= 2.237.0"') &&
        plugin.include?('gem "fastlane-plugin-firebase_app_distribution", "= 1.0.0"') &&
        lock.include?("fastlane (2.237.0)") && lock.include?("fastlane-plugin-firebase_app_distribution (1.0.0)")
    rescue Errno::EACCES
      false
    end

    def pubspec_has_build_runner?(project_root)
      path = File.join(project_root, "pubspec.yaml")
      safe_regular_file?(path) && File.read(path).match?(/^\s*build_runner:\s/m)
    rescue Errno::EACCES
      false
    end

    def local_key_properties_complete?(project_root)
      path = File.join(File.expand_path(project_root.to_s), "android", "key.properties")
      return false unless safe_regular_file?(path)
      keys = File.readlines(path, chomp: true).each_with_object({}) do |line, result|
        next if line.strip.empty? || line.lstrip.start_with?("#")
        key, value = line.split("=", 2)
        result[key.to_s.strip] = value.to_s unless key.nil?
      end
      return false unless %w[storeFile storePassword keyAlias keyPassword].all? { |key| !blank?(keys[key]) }
      store_file = java_properties_unescape(keys.fetch("storeFile"))
      keystore = if store_file.start_with?(File::SEPARATOR)
        store_file
      else
        File.expand_path(store_file, File.join(project_root, "android", "app"))
      end
      safe_regular_file?(keystore) && File.size(keystore).positive?
    rescue Errno::EACCES, ConfigurationError
      false
    end

    def valid_key_properties_override?(path)
      validate_key_properties_override!(path)
      true
    rescue ConfigurationError
      false
    end

    def validate_key_properties_override!(path)
      expanded = File.expand_path(path.to_s)
      parent = File.dirname(expanded)
      unless File.file?(expanded) && !File.symlink?(expanded) && (File.stat(expanded).mode & 0o777) == 0o600
        raise ConfigurationError, "ANDROID_KEY_PROPERTIES_PATH must be a private mode-0600 regular file"
      end
      unless File.directory?(parent) && !File.symlink?(parent) && (File.stat(parent).mode & 0o777) == 0o700
        raise ConfigurationError, "ANDROID_KEY_PROPERTIES_PATH must be contained by a private mode-0700 directory"
      end
      canonical_parent = File.realpath(parent)
      canonical_path = File.realpath(expanded)
      unless File.dirname(canonical_path) == canonical_parent
        raise ConfigurationError, "ANDROID_KEY_PROPERTIES_PATH escapes its private directory"
      end

      properties = read_key_properties(canonical_path)
      required = %w[storeFile storePassword keyAlias keyPassword]
      unless required.all? { |key| !blank?(properties[key]) }
        raise ConfigurationError, "ANDROID_KEY_PROPERTIES_PATH is incomplete"
      end
      store_file = java_properties_unescape(properties.fetch("storeFile"))
      unless store_file.start_with?(File::SEPARATOR)
        raise ConfigurationError, "ANDROID_KEY_PROPERTIES_PATH storeFile must be absolute"
      end
      unless safe_regular_file?(store_file) && File.size(store_file).positive?
        raise ConfigurationError, "ANDROID_KEY_PROPERTIES_PATH storeFile must be a nonempty regular file"
      end
      canonical_path
    rescue Errno::EACCES, Errno::ENOENT, Errno::ENOTDIR
      raise ConfigurationError, "ANDROID_KEY_PROPERTIES_PATH is not safely readable"
    end

    def read_key_properties(path)
      properties = {}
      File.foreach(path) do |line|
        stripped = line.chomp
        next if stripped.strip.empty? || stripped.lstrip.start_with?("#", "!")
        key, value = stripped.split(/(?<!\\)[=:]/, 2)
        raise ConfigurationError, "ANDROID_KEY_PROPERTIES_PATH contains an invalid property" if value.nil?
        normalized_key = key.to_s.strip
        if properties.key?(normalized_key)
          raise ConfigurationError, "ANDROID_KEY_PROPERTIES_PATH contains a duplicate property"
        end
        properties[normalized_key] = value.to_s.sub(/\A\s+/, "")
      end
      properties
    end

    def prepare_configuration(env)
      mode = env.fetch("RUN_BUILD_RUNNER", "auto").to_s.strip.downcase
      unless %w[auto true false].include?(mode)
        raise ConfigurationError, "RUN_BUILD_RUNNER must be auto, true, or false"
      end
      {
        run_tests: truthy?(env.fetch("RUN_FLUTTER_TESTS", "false")),
        run_analyze: truthy?(env.fetch("RUN_FLUTTER_ANALYZE", "true")),
        build_runner: mode
      }
    end

    def java_properties_unescape(value)
      input = value.to_s
      output = +""
      index = 0
      while index < input.length
        character = input[index]
        unless character == "\\"
          output << character
          index += 1
          next
        end
        index += 1
        raise ConfigurationError, "invalid Java properties escape" if index >= input.length
        escaped = input[index]
        if escaped == "u"
          hex = input[(index + 1), 4]
          raise ConfigurationError, "invalid Java properties Unicode escape" unless hex && hex.match?(/\A[0-9A-Fa-f]{4}\z/)
          unit = Integer(hex, 16)
          if unit.between?(0xd800, 0xdbff)
            pair = input[(index + 5), 6]
            unless pair && pair.match?(/\A\\u[0-9A-Fa-f]{4}\z/)
              raise ConfigurationError, "invalid Java properties Unicode surrogate pair"
            end
            low = Integer(pair[2, 4], 16)
            unless low.between?(0xdc00, 0xdfff)
              raise ConfigurationError, "invalid Java properties Unicode surrogate pair"
            end
            codepoint = 0x10000 + ((unit - 0xd800) << 10) + (low - 0xdc00)
            output << codepoint.chr(Encoding::UTF_8)
            index += 11
          elsif unit.between?(0xdc00, 0xdfff)
            raise ConfigurationError, "invalid Java properties Unicode surrogate pair"
          else
            output << unit.chr(Encoding::UTF_8)
            index += 5
          end
        else
          output << ({ "t" => "\t", "n" => "\n", "r" => "\r", "f" => "\f" }.fetch(escaped, escaped))
          index += 1
        end
      end
      output
    end

    def release_artifact_type(steps, env)
      return "AAB" if steps == ["play-store"]
      requested = normalize_artifact_type(env.fetch("FIREBASE_ANDROID_ARTIFACT_TYPE", "AAB"))
      if steps.include?("play-store") && requested != "AAB"
        raise ConfigurationError, "both requires AAB so the Play artifact can be reused without rebuilding"
      end
      requested
    end

    def validate_release_policy!(steps, env, artifact_type)
      if steps.include?("play-store")
        status = env.fetch("PLAY_STORE_RELEASE_STATUS", "completed")
        unless %w[completed draft inProgress].include?(status)
          if status == "halted"
            raise ConfigurationError, "halted mutates an existing rollout and is outside this new-binary lane"
          end
          raise ConfigurationError, "release status must be completed, draft, or inProgress"
        end
        if status == "inProgress"
          begin
            rollout = Float(env["PLAY_STORE_ROLLOUT"])
          rescue ArgumentError, TypeError
            raise ConfigurationError, "inProgress requires PLAY_STORE_ROLLOUT strictly between 0 and 1"
          end
          unless rollout > 0.0 && rollout < 1.0
            raise ConfigurationError, "inProgress requires PLAY_STORE_ROLLOUT strictly between 0 and 1"
          end
        end
      end
      if steps.include?("play-store") && env.fetch("PLAY_STORE_TRACK", "internal") == "production" &&
          !confirmed?(env["CONFIRM_PRODUCTION_DEPLOY"])
        raise ConfigurationError, "production requires CONFIRM_PRODUCTION_DEPLOY=true"
      end
      if steps.include?("firebase") && artifact_type == "AAB" &&
          !confirmed?(env["CONFIRM_FIREBASE_AAB_PLAY_LINKED"])
        raise ConfigurationError,
          "Firebase AAB distribution requires CONFIRM_FIREBASE_AAB_PLAY_LINKED=true after link and certificate review"
      end
    end

    def apply_authorized_release_policy!(options, env, steps)
      return unless steps.include?("play-store")

      requested_status = present(options[:release_status])
      requested_rollout = present(options[:rollout])
      ambient_status = present(env["PLAY_STORE_RELEASE_STATUS"])
      ambient_rollout = present(env["PLAY_STORE_ROLLOUT"])

      if requested_status.nil?
        if (!ambient_status.nil? && ambient_status != "completed") || !ambient_rollout.nil?
          raise ConfigurationError,
            "non-default Play release status or rollout must be an exact lane option with separate confirmation"
        end
        env["PLAY_STORE_RELEASE_STATUS"] = "completed"
        env.delete("PLAY_STORE_ROLLOUT")
        return
      end

      unless %w[completed draft inProgress].include?(requested_status)
        raise ConfigurationError, "release status must be completed, draft, or inProgress"
      end
      if requested_status != "completed" && !confirmed?(env["CONFIRM_PLAY_RELEASE_POLICY"])
        raise ConfigurationError,
          "non-default Play release status requires CONFIRM_PLAY_RELEASE_POLICY=true"
      end
      if requested_status == "inProgress"
        if requested_rollout.nil? || !confirmed?(env["CONFIRM_PLAY_RELEASE_POLICY"])
          raise ConfigurationError,
            "inProgress requires an exact rollout lane option and CONFIRM_PLAY_RELEASE_POLICY=true"
        end
        env["PLAY_STORE_ROLLOUT"] = requested_rollout
      elsif requested_rollout
        raise ConfigurationError, "rollout is accepted only with release_status:inProgress"
      else
        env.delete("PLAY_STORE_ROLLOUT")
      end
      env["PLAY_STORE_RELEASE_STATUS"] = requested_status
    end

    def validate_retry_reconciliation!(options, env, target)
      retry_marker = present(env["RETRY_UNKNOWN_UPLOAD"])
      unless retry_marker.nil? || %w[true false].include?(retry_marker)
        raise ConfigurationError, "RETRY_UNKNOWN_UPLOAD must be exactly true or false"
      end
      return unless retry_marker == "true"

      unless confirmed?(env["CONFIRM_UPLOAD_RECONCILED"])
        raise ConfigurationError,
          "unknown upload retry requires CONFIRM_UPLOAD_RECONCILED=true after provider reconciliation"
      end
      reconciled_version = normalize_version_name(env["RECONCILED_VERSION_NAME"])
      requested_version = present(options[:version_name]) || present(env["VERSION_NAME"])
      unless requested_version
        raise ConfigurationError, "unknown upload retry requires an explicit version_name lane option or VERSION_NAME"
      end
      if reconciled_version != normalize_version_name(requested_version)
        raise ConfigurationError, "reconciled version name must exactly match the requested release version"
      end
      reconciled_code = validate_version_code(
        env["RECONCILED_VERSION_CODE"], source: "reconciled version code"
      )
      unless env["RECONCILED_ARTIFACT_SHA256"].to_s.match?(/\A[0-9a-f]{64}\z/)
        raise ConfigurationError, "reconciled artifact SHA-256 must be exactly 64 lowercase hexadecimal characters"
      end
      expected_destinations = target == "both" ? "play-store,firebase" : target
      unless env["RECONCILED_DESTINATIONS"].to_s == expected_destinations
        raise ConfigurationError, "reconciled destinations must exactly match the authorized delivery target"
      end
      unless env["RECONCILED_PROVIDER_STATE"].to_s == "not-delivered"
        raise ConfigurationError, "provider reconciliation must prove the exact prior upload was not delivered"
      end
      {
        version_code: reconciled_code,
        artifact_sha256: env["RECONCILED_ARTIFACT_SHA256"].to_s
      }
    end

    def prepare_credentials(steps:, env:, project_root:, temp_root:, records:)
      credentials = {}
      if steps.include?("play-store")
        record = resolve_secret(
          path_value: env["GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_PATH"],
          base64_value: env["GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_BASE64"],
          default_path: File.join(project_root, "android", "fastlane", "google-play-service-account.json"),
          label: "Google Play service account", temp_root: temp_root
        )
        validate_service_account_json!(record[:path], "Google Play service account")
        records << record
        credentials[:play] = record
      end
      if steps.include?("firebase")
        raise ConfigurationError, "FIREBASE_APP_ID is required" if blank?(env["FIREBASE_APP_ID"])
        record = resolve_secret(
          path_value: env["FIREBASE_SERVICE_ACCOUNT_JSON_PATH"],
          base64_value: env["FIREBASE_SERVICE_ACCOUNT_JSON_BASE64"],
          default_path: File.join(project_root, "android", "fastlane", "firebase-service-account.json"),
          label: "Firebase service account", temp_root: temp_root
        )
        validate_service_account_json!(record[:path], "Firebase service account")
        records << record
        credentials[:firebase] = record
      end
      credentials
    end

    def validate_service_account_json!(path, label)
      document = JSON.parse(File.binread(path))
      valid = document.is_a?(Hash) && document["type"] == "service_account" &&
        !blank?(document["client_email"]) && !blank?(document["private_key"])
      raise ConfigurationError, "#{label} JSON is not a complete service-account document" unless valid
    rescue JSON::ParserError
      raise ConfigurationError, "#{label} JSON is invalid"
    end

    def prepare_signing(env:, project_root:, temp_root:, records:)
      workspace = File.join(project_root, "android", "key.properties")
      ci = truthy?(env["CI"]) || truthy?(env["GITHUB_ACTIONS"])
      if ci && (File.exist?(workspace) || File.symlink?(workspace))
        raise ConfigurationError, "CI refuses a workspace android/key.properties; use the temporary override"
      end

      unless blank?(env["ANDROID_KEY_PROPERTIES_PATH"])
        override = validate_key_properties_override!(env["ANDROID_KEY_PROPERTIES_PATH"])
        return { "ANDROID_KEY_PROPERTIES_PATH" => override }
      end

      input_names = %w[ANDROID_KEYSTORE_PATH ANDROID_KEYSTORE_BASE64 ANDROID_KEYSTORE_PASSWORD ANDROID_KEY_ALIAS ANDROID_KEY_PASSWORD]
      any_input = input_names.any? { |name| !blank?(env[name]) }
      unless any_input
        if !ci && local_key_properties_complete?(project_root)
          return {}
        end
        raise ConfigurationError, "complete Android signing inputs are required"
      end
      unless signing_inputs_complete?(env)
        raise ConfigurationError, "Android signing environment inputs are incomplete"
      end

      keystore = resolve_secret(
        path_value: env["ANDROID_KEYSTORE_PATH"], base64_value: env["ANDROID_KEYSTORE_BASE64"],
        default_path: nil, label: "Android keystore", temp_root: temp_root
      )
      records << keystore
      properties_path = File.join(temp_root, "android-key-#{SecureRandom.hex(10)}.properties")
      write_key_properties(
        path: properties_path, keystore_path: keystore[:path],
        store_password: env["ANDROID_KEYSTORE_PASSWORD"], key_alias: env["ANDROID_KEY_ALIAS"],
        key_password: env["ANDROID_KEY_PASSWORD"]
      )
      properties_record = { path: properties_path, owned: true, label: "Android key properties", root: temp_root }
      records << properties_record
      { "ANDROID_KEY_PROPERTIES_PATH" => properties_path }
    end

    def read_pubspec_version(project_root)
      path = File.join(project_root, "pubspec.yaml")
      raise ConfigurationError, "pubspec.yaml is missing" unless safe_regular_file?(path)
      raw = nil
      File.foreach(path) do |line|
        match = line.match(/^version:\s*['\"]?([^'\"\s#]+)['\"]?\s*(?:#.*)?$/)
        if match
          raw = match[1]
          break
        end
      end
      raise ConfigurationError, "pubspec.yaml has no static version" if blank?(raw)
      name, code = raw.split("+", 2)
      [name, code]
    end

    def resolve_play_version_code(steps:, env:, actions:, json_key:, package_name:)
      selected = env.fetch("PLAY_STORE_TRACK", "internal").to_s.strip
      configured = env.fetch("PLAY_STORE_VERSION_TRACKS", DEFAULT_PLAY_TRACKS.join(","))
        .split(",").map(&:strip).reject(&:empty?)
      tracks = ordered_unique([selected] + configured)
      next_active_track_code(
        track_names: tracks,
        fetch_track_codes: lambda do |track|
          actions.google_play_track_version_codes(
            json_key: json_key, package_name: package_name, track: track
          )
        end
      )
    end

    def resolve_local_version_code(env, pubspec_code, actions)
      return validate_version_code(env["VERSION_CODE"], source: "VERSION_CODE") unless blank?(env["VERSION_CODE"])
      return validate_version_code(pubspec_code, source: "pubspec build number") unless blank?(pubspec_code)
      validate_version_code(actions.git_commit_count, source: "Git commit count")
    end

    def validate_package_name!(configured, detected)
      if blank?(detected)
        raise ConfigurationError, "could not resolve the selected release applicationId"
      end
      return if configured.to_s == detected.to_s
      raise ConfigurationError, "APP_PACKAGE_NAME does not match the selected release applicationId"
    end

    def validate_firebase_mapping!(env, actions, flavor:)
      mappings = Array(actions.firebase_clients(flavor: flavor))
      if mappings.empty?
        unless confirmed?(env["CONFIRM_FIREBASE_PACKAGE_MATCH"])
          raise ConfigurationError,
            "google-services.json mapping evidence is absent; require CONFIRM_FIREBASE_PACKAGE_MATCH=true"
        end
        return
      end
      package_name = env.fetch("APP_PACKAGE_NAME")
      app_id = env.fetch("FIREBASE_APP_ID")
      matched = mappings.select do |mapping|
        values = symbolize_keys(mapping)
        values[:package_name].to_s == package_name && values[:app_id].to_s == app_id
      end
      conflicts = mappings.select do |mapping|
        values = symbolize_keys(mapping)
        values[:package_name].to_s == package_name || values[:app_id].to_s == app_id
      end
      return if matched.length == 1 && conflicts.length == 1
      raise ConfigurationError,
        "detected google-services.json package/app-ID mapping does not match the selected release"
    end

    def build_once(project_root:, artifact_type:, version_name:, version_code:, flavor:, target:, environment:, actions:)
      type = normalize_artifact_type(artifact_type)
      output_root = File.join(project_root, "build", "app", "outputs")
      selected_flavor = present(flavor)
      before = artifact_inventory(output_root, type)
      existing = before.select { |entry| entry[:state] == :variant && entry[:flavor] == selected_flavor }
        .map { |entry| entry[:path] }
      unrelated = before.reject { |entry| existing.include?(entry[:path]) }.map { |entry| entry[:path] }
      quarantine = Dir.mktmpdir("artifact-quarantine-", File.dirname(project_root))
      moved = []
      accepted = false
      begin
        existing.each_with_index do |path, index|
          destination = File.join(quarantine, index.to_s)
          File.rename(path, destination)
          moved << [path, destination]
        end
        started_at = Time.now - 2
        actions.flutter_build(
          artifact_type: type, build_name: version_name, build_number: version_code,
          flavor: flavor, target: target, environment: environment
        )
        artifact = locate_fresh_artifact(
          project_root: project_root, build_started_at: started_at,
          prior_outputs: unrelated, flavor: selected_flavor, artifact_type: type
        )
        accepted = true
        FileUtils.remove_entry_secure(quarantine)
        quarantine = nil
        artifact
      rescue Exception # rubocop:disable Lint/RescueException -- rollback must run for signals too
        unless accepted
          artifact_inventory(output_root, type).each do |entry|
            next unless entry[:state] == :variant && entry[:flavor] == selected_flavor
            File.unlink(entry[:path]) if safe_regular_file?(entry[:path])
          rescue Errno::ENOENT
            nil
          end
          moved.reverse_each do |original, stored|
            next unless safe_regular_file?(stored)
            FileUtils.mkdir_p(File.dirname(original))
            File.rename(stored, original)
          end
        end
        raise
      ensure
        FileUtils.remove_entry_secure(quarantine) if quarantine && File.directory?(quarantine)
      end
    end

    def upload_play_store(env:, actions:, credential:, artifact_path:, version_name:)
      status = env.fetch("PLAY_STORE_RELEASE_STATUS", "completed")
      options = {
        json_key: credential.fetch(:path),
        aab: artifact_path,
        package_name: env.fetch("APP_PACKAGE_NAME"),
        track: env.fetch("PLAY_STORE_TRACK", "internal"),
        release_status: status,
        version_name: version_name,
        skip_upload_metadata: true,
        skip_upload_changelogs: true,
        skip_upload_images: true,
        skip_upload_screenshots: true
      }
      options[:rollout] = Float(env.fetch("PLAY_STORE_ROLLOUT")) if status == "inProgress"
      actions.upload_to_play_store(**options)
    rescue ReleaseError
      raise
    rescue StandardError => error
      raise ExternalActionError, "Google Play binary upload failed: #{classify_play_failure(error)}"
    end

    def classify_play_failure(error)
      text = error.message.to_s.downcase
      if text.match?(/permission|unauthori[sz]ed|forbidden|credential|authentication|\b401\b|\b403\b/)
        "authentication or permission was rejected; verify the service account and Play Console access"
      elsif text.match?(/first release|first upload|draft app|not published|no app with given|application.*not found/)
        "the app requires first-release/manual bootstrap in Play Console; follow the first-release checklist"
      elsif text.match?(/version code.*already|already been used|version.*reuse/)
        "the active-track version code was rejected as reused; refresh every configured track and retry the serialized upload"
      else
        "the Play action failed (#{error.class})"
      end
    end

    def upload_firebase(env:, actions:, credential:, artifact_path:, artifact_type:, version_name:, version_code:)
      notes = present(env["FIREBASE_RELEASE_NOTES"]) || "Version #{version_name} (#{version_code})"
      actions.firebase_app_distribution(
        app: env.fetch("FIREBASE_APP_ID"),
        android_artifact_type: artifact_type,
        android_artifact_path: artifact_path,
        service_credentials_file: credential.fetch(:path),
        release_notes: notes,
        testers: present(env["FIREBASE_TESTERS"]),
        groups: present(env["FIREBASE_TESTER_GROUPS"])
      )
    rescue ReleaseError
      raise
    rescue StandardError => error
      raise ExternalActionError, "Firebase distribution failed: #{error.class}"
    end

    def result_payload(status:, target:, version:, track:, artifact_type:, artifact_path:, successful:, failed_destination:, message:)
      {
        "schema_version" => RESULT_SCHEMA_VERSION,
        "status" => status,
        "target" => target,
        "version" => version,
        "track" => track,
        "artifact_type" => artifact_type,
        "artifact_path" => artifact_path,
        "successful_destinations" => successful.dup,
        "failed_destination" => failed_destination,
        "message" => message
      }
    end

    def write_result_if_requested(env, result, actions, preserve: nil)
      path = present(env["RELEASE_RESULT_PATH"])
      return if path.nil?
      destination = File.expand_path(path)
      FileUtils.mkdir_p(File.dirname(destination))
      temp = Tempfile.new([".release-result-", ".json"], File.dirname(destination), mode: 0o600)
      begin
        temp.write(JSON.generate(result))
        temp.write("\n")
        temp.flush
        temp.fsync
        temp.close
        File.rename(temp.path, destination)
        File.chmod(0o600, destination)
      ensure
        temp.close! rescue nil
      end
    rescue StandardError => error
      begin
        actions.log(:warn, "WARN: could not write the nonsecret release result (#{error.class})") if actions.respond_to?(:log)
      rescue StandardError
        nil
      end
      raise error unless preserve
    end

    def log_result(actions, result, preserve: nil)
      fields = %w[status target version track artifact_type artifact_path successful_destinations failed_destination message]
      fields.each do |field|
        actions.log(:info, "#{field}=#{result[field].is_a?(Array) ? result[field].join(",") : result[field]}") if actions.respond_to?(:log)
      end
    rescue StandardError
      raise unless preserve
    end

    def notify_if_requested(env, actions, result)
      return if env["SLACK_NOTIFICATION_OWNER"].to_s == "github-actions"
      return if truthy?(env["RETRY_UNKNOWN_UPLOAD"])
      return unless confirmed?(env["CONFIRM_SLACK_NOTIFICATION"])
      webhook = present(env["SLACK_WEBHOOK_URL"])
      return unless webhook
      preference_name = result["status"] == "SUCCESS" ? "SLACK_NOTIFY_SUCCESS" : "SLACK_NOTIFY_FAILURE"
      preference = present(env[preference_name])
      notify = preference.nil? ? true : truthy?(preference)
      return unless notify
      payload = slack_payload(
        repository: env["GITHUB_REPOSITORY"], version: result["version"], track: result["track"],
        result: result["status"], run_url: run_url(env), source_url: source_url(env)
      )
      actions.notify_slack(webhook: webhook, payload: payload)
    rescue StandardError => error
      begin
        actions.log(:warn, "WARN: Slack notification failed without changing the release result (#{error.class})") if actions.respond_to?(:log)
      rescue StandardError
        nil
      end
    end

    def run_url(env)
      return env["RUN_URL"] unless blank?(env["RUN_URL"])
      return "" if blank?(env["GITHUB_SERVER_URL"]) || blank?(env["GITHUB_REPOSITORY"]) || blank?(env["GITHUB_RUN_ID"])
      "#{env["GITHUB_SERVER_URL"]}/#{env["GITHUB_REPOSITORY"]}/actions/runs/#{env["GITHUB_RUN_ID"]}"
    end

    def source_url(env)
      return env["SOURCE_URL"] unless blank?(env["SOURCE_URL"])
      return "" if blank?(env["GITHUB_SERVER_URL"]) || blank?(env["GITHUB_REPOSITORY"]) || blank?(env["GITHUB_SHA"])
      "#{env["GITHUB_SERVER_URL"]}/#{env["GITHUB_REPOSITORY"]}/commit/#{env["GITHUB_SHA"]}"
    end
  end

  # The only object allowed to invoke Fastlane actions. Keeping this adapter
  # narrow makes all network-facing calls mockable in pure Minitest.
  class FastlaneAdapter
    attr_reader :project_root

    def initialize(dsl, project_root: nil, command_runner: nil)
      @dsl = dsl
      @project_root = project_root || File.expand_path("../../..", __dir__)
      @command_runner = command_runner
    end

    def exact_head_tags
      output = @dsl.sh("git", "tag", "--points-at", "HEAD", log: false)
      output.to_s.lines.map(&:strip).reject(&:empty?)
    end

    def runtime_ruby_version
      RUBY_VERSION
    end

    def tool_available?(name)
      ENV.fetch("PATH", "").split(File::PATH_SEPARATOR).any? do |directory|
        path = File.join(directory, name.to_s)
        File.file?(path) && File.executable?(path)
      end
    end

    def git_commit_count
      @dsl.sh("git", "rev-list", "--count", "HEAD", log: false).to_s.strip
    end

    def prepare(run_tests:, run_analyze:, build_runner:)
      mode = build_runner.to_s
      unless %w[auto true false].include?(mode)
        raise ConfigurationError, "RUN_BUILD_RUNNER must be auto, true, or false"
      end
      @dsl.sh("flutter", "pub", "get")
      if mode == "true" || (mode == "auto" && build_runner_dependency?)
        @dsl.sh("dart", "run", "build_runner", "build", "--delete-conflicting-outputs")
      end
      @dsl.sh("flutter", "analyze") if run_analyze
      @dsl.sh("flutter", "test") if run_tests
    end

    def build_runner_dependency?
      pubspec = File.join(@project_root, "pubspec.yaml")
      return false unless File.file?(pubspec) && !File.symlink?(pubspec)
      entries = []
      section = nil
      File.foreach(pubspec) do |line|
        next if line.strip.empty? || line.lstrip.start_with?("#")
        if line.match?(/\A(?:dependencies|dev_dependencies):\s*(?:#.*)?\z/)
          section = true
          next
        end
        if line.match?(/\A[^[:space:]#][^:]*:/)
          section = nil
          next
        end
        next unless section
        match = line.match(/\A([[:space:]]+)([A-Za-z0-9_-]+)\s*:/)
        entries << [match[1].length, match[2]] if match
      end
      return false if entries.empty?
      minimum = entries.map(&:first).min
      entries.any? { |indent, name| indent == minimum && name == "build_runner" }
    end

    def flutter_build(artifact_type:, build_name:, build_number:, flavor:, target:, environment:)
      command = ["flutter", "build", artifact_type == "AAB" ? "appbundle" : "apk", "--release",
        "--build-name", build_name.to_s, "--build-number", build_number.to_s, "--target", target.to_s]
      command.concat(["--flavor", flavor.to_s]) if flavor
      @dsl.sh(environment, *command)
    end

    def release_application_id(flavor:)
      FlutterPlayStoreRelease.send(:read_release_application_id, @project_root, flavor)
    end

    def firebase_clients(flavor:)
      FlutterPlayStoreRelease.send(:read_firebase_clients, @project_root, flavor)
    end

    def google_play_track_version_codes(**options)
      @dsl.google_play_track_version_codes(**options)
    end

    def upload_to_play_store(**options)
      @dsl.upload_to_play_store(**options)
    end

    def firebase_app_distribution(**options)
      @dsl.firebase_app_distribution(**options)
    end

    def notify_slack(webhook:, payload:)
      config = Tempfile.new("fprs-curl-config")
      File.chmod(0o600, config.path)
      config.write("url = #{JSON.generate(webhook)}\n")
      config.flush
      command = ["curl", "--silent", "--show-error", "--fail-with-body", "--config", config.path,
        "--header", "Content-Type: application/json", "--data-binary", "@-"]
      _stdout, _stderr, status = if @command_runner
        @command_runner.call(command, payload)
      else
        Open3.capture3(*command, stdin_data: payload)
      end
      raise ExternalActionError, "Slack webhook request failed" unless status.success?
      true
    ensure
      config.close! if config
    end

    def log(level, message)
      if defined?(FastlaneCore::UI)
        method = level.to_sym == :warn ? :important : (level.to_sym == :error ? :error : :message)
        FastlaneCore::UI.public_send(method, message)
      else
        $stderr.puts(message)
      end
    end

    def fail!(message)
      if defined?(FastlaneCore::UI)
        FastlaneCore::UI.user_error!(message)
      end
      raise ReleaseError, message
    end
  end

  class << self
    private

    def read_release_application_id(project_root, flavor)
      candidates = %w[android/app/build.gradle.kts android/app/build.gradle].map { |path| File.join(project_root, path) }
      path = candidates.find { |candidate| safe_regular_file?(candidate) }
      return nil unless path
      tokens = gradle_tokens(File.read(path))
      return nil unless tokens
      brace_pairs = gradle_brace_pairs(tokens)
      return nil unless brace_pairs

      android_blocks = gradle_direct_named_blocks(tokens, 0, tokens.length, "android", brace_pairs)
      return nil unless android_blocks.length == 1
      android_open, android_close = android_blocks.first

      default_blocks = gradle_direct_named_blocks(
        tokens, android_open + 1, android_close, "defaultConfig", brace_pairs
      )
      return nil unless default_blocks.length == 1
      base_values = gradle_static_declarations(tokens, *default_blocks.first, "applicationId", brace_pairs)
      return nil unless base_values && base_values.length == 1
      identifier = base_values.first

      selected_flavor = present(flavor)
      if selected_flavor
        return nil unless selected_flavor.match?(/\A[A-Za-z0-9_-]+\z/)
        flavor_containers = gradle_direct_named_blocks(
          tokens, android_open + 1, android_close, "productFlavors", brace_pairs
        )
        return nil unless flavor_containers.length == 1
        flavor_blocks = gradle_direct_variant_blocks(
          tokens, flavor_containers.first[0] + 1, flavor_containers.first[1], selected_flavor, brace_pairs
        )
        return nil unless flavor_blocks.length == 1

        explicit_values = gradle_static_declarations(tokens, *flavor_blocks.first, "applicationId", brace_pairs)
        suffix_values = gradle_static_declarations(tokens, *flavor_blocks.first, "applicationIdSuffix", brace_pairs)
        return nil unless explicit_values && suffix_values
        return nil if explicit_values.length > 1 || suffix_values.length > 1
        identifier = explicit_values.first if explicit_values.length == 1
        identifier = "#{identifier}#{suffix_values.first}" if suffix_values.length == 1
      end

      build_type_containers = gradle_direct_named_blocks(
        tokens, android_open + 1, android_close, "buildTypes", brace_pairs
      )
      return nil if build_type_containers.length > 1
      if build_type_containers.length == 1
        release_blocks = gradle_direct_variant_blocks(
          tokens, build_type_containers.first[0] + 1, build_type_containers.first[1], "release", brace_pairs
        )
        return nil if release_blocks.length > 1
        if release_blocks.length == 1
          release_ids = gradle_static_declarations(tokens, *release_blocks.first, "applicationId", brace_pairs)
          release_suffixes = gradle_static_declarations(
            tokens, *release_blocks.first, "applicationIdSuffix", brace_pairs
          )
          return nil unless release_ids && release_suffixes
          return nil unless release_ids.empty? && release_suffixes.length <= 1
          identifier = "#{identifier}#{release_suffixes.first}" if release_suffixes.length == 1
        end
      end

      identifier.match?(/\A[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+\z/) ? identifier : nil
    rescue Errno::EACCES, EncodingError
      nil
    end

    def gradle_tokens(text)
      tokens = []
      index = 0
      while index < text.length
        character = text[index]
        following = text[index + 1]
        if character == "\n"
          tokens << [:newline, character]
          index += 1
        elsif character.match?(/[\t\r ]/)
          index += 1
        elsif character == "/" && following == "/"
          index += 2
          index += 1 while index < text.length && text[index] != "\n"
        elsif character == "/" && following == "*"
          index += 2
          closed = false
          while index < text.length
            tokens << [:newline, "\n"] if text[index] == "\n"
            if text[index] == "*" && text[index + 1] == "/"
              index += 2
              closed = true
              break
            end
            index += 1
          end
          return nil unless closed
        elsif character == '"' || character == "'"
          quote = character
          value = +""
          static = true
          index += 1
          closed = false
          while index < text.length
            current = text[index]
            if current == quote
              index += 1
              closed = true
              break
            elsif current == "\\"
              static = false
              index += 1
              return nil if index >= text.length
              value << text[index]
            else
              static = false if quote == '"' && current == "$"
              value << current
            end
            index += 1
          end
          return nil unless closed
          tokens << [static ? :string : :dynamic_string, value]
        elsif character.match?(/[A-Za-z_]/)
          finish = index + 1
          finish += 1 while finish < text.length && text[finish].match?(/[A-Za-z0-9_]/)
          tokens << [:identifier, text[index...finish]]
          index = finish
        else
          tokens << [:symbol, character]
          index += 1
        end
      end
      tokens
    end

    def gradle_brace_pairs(tokens)
      stack = []
      pairs = {}
      tokens.each_with_index do |token, index|
        next unless token[0] == :symbol
        if token[1] == "{"
          stack << index
        elsif token[1] == "}"
          return nil if stack.empty?
          opening = stack.pop
          pairs[opening] = index
        end
      end
      stack.empty? ? pairs : nil
    end

    def gradle_significant_index(tokens, index, limit)
      while index < limit && (tokens[index][0] == :newline || tokens[index] == [:symbol, ";"])
        index += 1
      end
      index
    end

    def gradle_direct_named_blocks(tokens, first, limit, name, brace_pairs)
      blocks = []
      index = first
      while index < limit
        token = tokens[index]
        if token == [:symbol, "{"]
          index = brace_pairs.fetch(index) + 1
          next
        end
        if token == [:identifier, name]
          opening = gradle_significant_index(tokens, index + 1, limit)
          if opening < limit && tokens[opening] == [:symbol, "{"]
            blocks << [opening, brace_pairs.fetch(opening)]
            index = brace_pairs.fetch(opening) + 1
            next
          end
        end
        index += 1
      end
      blocks
    end

    def gradle_direct_variant_blocks(tokens, first, limit, name, brace_pairs)
      factories = %w[create maybeCreate getByName named]
      blocks = []
      index = first
      while index < limit
        token = tokens[index]
        if token == [:symbol, "{"]
          index = brace_pairs.fetch(index) + 1
          next
        end
        opening = nil
        if token == [:identifier, name]
          candidate = gradle_significant_index(tokens, index + 1, limit)
          opening = candidate if candidate < limit && tokens[candidate] == [:symbol, "{"]
        elsif token[0] == :identifier && factories.include?(token[1])
          left = gradle_significant_index(tokens, index + 1, limit)
          value = gradle_significant_index(tokens, left + 1, limit)
          right = gradle_significant_index(tokens, value + 1, limit)
          candidate = gradle_significant_index(tokens, right + 1, limit)
          if left < limit && tokens[left] == [:symbol, "("] && value < limit &&
              tokens[value] == [:string, name] && right < limit && tokens[right] == [:symbol, ")"] &&
              candidate < limit && tokens[candidate] == [:symbol, "{"]
            opening = candidate
          end
        end
        if opening
          blocks << [opening, brace_pairs.fetch(opening)]
          index = brace_pairs.fetch(opening) + 1
        else
          index += 1
        end
      end
      blocks
    end

    def gradle_static_declarations(tokens, opening, closing, name, brace_pairs)
      values = []
      index = opening + 1
      while index < closing
        token = tokens[index]
        if token == [:symbol, "{"]
          index = brace_pairs.fetch(index) + 1
          next
        end
        unless token == [:identifier, name]
          index += 1
          next
        end

        value_index = gradle_significant_index(tokens, index + 1, closing)
        if value_index < closing && tokens[value_index] == [:symbol, "="]
          value_index = gradle_significant_index(tokens, value_index + 1, closing)
        end
        if value_index < closing && tokens[value_index] == [:symbol, "("]
          string_index = gradle_significant_index(tokens, value_index + 1, closing)
          right = gradle_significant_index(tokens, string_index + 1, closing)
          return nil unless string_index < closing && tokens[string_index][0] == :string
          return nil unless right < closing && tokens[right] == [:symbol, ")"]
          value = tokens[string_index][1]
          after = right + 1
        else
          return nil unless value_index < closing && tokens[value_index][0] == :string
          value = tokens[value_index][1]
          after = value_index + 1
        end
        return nil unless after >= closing || tokens[after][0] == :newline || tokens[after] == [:symbol, ";"]
        values << value
        index = after
      end
      values
    end

    def read_firebase_clients(project_root, flavor)
      selected = present(flavor)
      if selected && !selected.match?(/\A[A-Za-z0-9_-]+\z/)
        raise ConfigurationError, "selected flavor cannot be mapped to a Firebase source set"
      end
      app_root = File.join(project_root, "android", "app")
      paths = []
      paths << File.join(app_root, "src", "#{selected}Release", "google-services.json") if selected
      paths << File.join(app_root, "src", "release", "google-services.json")
      paths << File.join(app_root, "src", selected, "google-services.json") if selected
      paths << File.join(app_root, "google-services.json")
      path = paths.find do |candidate|
        if File.symlink?(candidate) || (File.exist?(candidate) && !File.file?(candidate))
          raise ConfigurationError, "selected google-services.json evidence is not a regular file"
        end
        safe_regular_file?(candidate)
      end
      return [] unless path
      mappings = []
      document = JSON.parse(File.read(path))
      Array(document["client"]).each do |client|
        app_id = client.dig("client_info", "mobilesdk_app_id")
        package_name = client.dig("client_info", "android_client_info", "package_name")
        mappings << { package_name: package_name, app_id: app_id } if package_name && app_id
      end
      mappings
    rescue JSON::ParserError
      raise ConfigurationError, "selected google-services.json evidence is invalid"
    end
  end
end

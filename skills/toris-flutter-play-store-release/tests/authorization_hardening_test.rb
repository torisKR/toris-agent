# frozen_string_literal: true

require_relative "fastlane_helper_test"
require "digest"

class FlutterPlayStoreReleaseCoordinatorTest
  def test_authorization_dual_delivery_requires_an_explicit_target_and_confirmation
    dual_env = common_env.merge(firebase_env,
      "GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_PATH" => @play_json)

    assert_raises(FPRS::ConfigurationError) { release(target: "both", env: dual_env) }
    assert_empty calls(:google_play_track_version_codes)
    assert_empty calls(:firebase_app_distribution)

    @actions = FakeActions.new(@project)
    result = release(target: "both", env: dual_env.merge("CONFIRM_DUAL_DELIVERY" => "true"))
    assert_equal %w[play-store firebase], result.fetch("successful_destinations")

    @actions = FakeActions.new(@project)
    assert_raises(FPRS::ConfigurationError) do
      FPRS.release(
        options: {},
        env: dual_env.merge(
          "DISTRIBUTION_TARGET" => "both",
          "ENABLE_FIREBASE_APP_DISTRIBUTION" => "true",
          "CONFIRM_DUAL_DELIVERY" => "true"
        ),
        actions: @actions,
        project_root: @project
      )
    end
    assert_empty calls(:google_play_track_version_codes)
  end

  def test_authorization_slack_requires_a_separate_explicit_confirmation
    slack_env = common_env.merge(
      "GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_PATH" => @play_json,
      "SLACK_WEBHOOK_URL" => "https://hooks.example.invalid/private",
      "SLACK_NOTIFY_SUCCESS" => "true"
    )

    release(target: "play-store", env: slack_env)
    assert_empty calls(:notify_slack)

    @actions = FakeActions.new(@project)
    release(target: "play-store", env: slack_env.merge("CONFIRM_SLACK_NOTIFICATION" => "true"))
    assert_equal 1, calls(:notify_slack).length
  end

  def test_authorization_nondefault_release_policy_must_be_exact_and_confirmed
    ambient = common_env.merge(
      "GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_PATH" => @play_json,
      "PLAY_STORE_RELEASE_STATUS" => "inProgress",
      "PLAY_STORE_ROLLOUT" => "0.2"
    )

    assert_raises(FPRS::ConfigurationError) { release(target: "play-store", env: ambient) }
    assert_empty calls(:google_play_track_version_codes)

    @actions = FakeActions.new(@project)
    FPRS.release(
      options: {
        distribution_target: "play-store",
        release_status: "inProgress",
        rollout: "0.2"
      },
      env: common_env.merge(
        "GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_PATH" => @play_json,
        "CONFIRM_PLAY_RELEASE_POLICY" => "true"
      ),
      actions: @actions,
      project_root: @project
    )
    assert_equal 0.2, calls(:upload_to_play_store).fetch(0).fetch(:rollout)
  end

  def test_authorization_unknown_outcome_retry_requires_exact_reconciliation_attestation
    retry_env = common_env.merge(
      "GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_PATH" => @play_json,
      "RETRY_UNKNOWN_UPLOAD" => "true"
    )
    assert_raises(FPRS::ConfigurationError) { release(target: "play-store", env: retry_env) }
    assert_empty calls(:google_play_track_version_codes)

    reconciliation = {
      "CONFIRM_UPLOAD_RECONCILED" => "true",
      "RECONCILED_VERSION_NAME" => "1.3.9",
      "RECONCILED_VERSION_CODE" => "42",
      "RECONCILED_ARTIFACT_SHA256" => Digest::SHA256.hexdigest("artifact 0"),
      "RECONCILED_DESTINATIONS" => "play-store",
      "RECONCILED_PROVIDER_STATE" => "not-delivered"
    }
    @actions = FakeActions.new(@project)
    assert_raises(FPRS::ConfigurationError) do
      release(target: "play-store", env: retry_env.merge(reconciliation))
    end
    assert_empty calls(:google_play_track_version_codes)

    @actions = FakeActions.new(@project)
    assert_raises(FPRS::ConfigurationError) do
      release(
        target: "play-store",
        env: retry_env.reject { |key, _| key == "VERSION_NAME" }.merge(
          reconciliation,
          "RECONCILED_VERSION_NAME" => "1.4.0"
        )
      )
    end
    assert_empty calls(:google_play_track_version_codes)

    @actions = FakeActions.new(@project)
    assert_raises(FPRS::ConfigurationError) do
      release(target: "play-store", env: retry_env.merge(
        reconciliation,
        "RECONCILED_VERSION_NAME" => "1.4.0",
        "RECONCILED_VERSION_CODE" => "41"
      ))
    end
    assert_empty calls(:flutter_build)
    assert_empty calls(:upload_to_play_store)

    @actions = FakeActions.new(@project)
    assert_raises(FPRS::ConfigurationError) do
      release(target: "play-store", env: retry_env.merge(
        reconciliation,
        "RECONCILED_VERSION_NAME" => "1.4.0",
        "RECONCILED_ARTIFACT_SHA256" => "a" * 64
      ))
    end
    assert_equal 1, calls(:flutter_build).length
    assert_empty calls(:upload_to_play_store)

    @actions = FakeActions.new(@project)
    release(target: "play-store", env: retry_env.merge(
      reconciliation,
      "RECONCILED_VERSION_NAME" => "1.4.0",
      "SLACK_WEBHOOK_URL" => "https://hooks.example.invalid/private",
      "CONFIRM_SLACK_NOTIFICATION" => "true"
    ))
    assert_equal 1, calls(:upload_to_play_store).length
    assert_empty calls(:notify_slack)
  end

  def test_authorization_confirmation_aliases_never_authorize_confirm_gates
    assert FPRS.send(:confirmed?, "true")
    ["1", "yes", "on", "TRUE", " true ", true].each do |value|
      refute FPRS.send(:confirmed?, value), "#{value.inspect} unexpectedly confirmed an external action"
    end

    %w[1 yes on].each do |alias_value|
      @actions = FakeActions.new(@project)
      assert_raises(FPRS::ConfigurationError) do
        release(
          target: "both",
          env: common_env.merge(
            firebase_env,
            "GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_PATH" => @play_json,
            "CONFIRM_DUAL_DELIVERY" => alias_value
          )
        )
      end
      assert_empty calls(:google_play_track_version_codes)
      assert_empty calls(:firebase_app_distribution)
    end
  end
end

class FlutterPlayStoreReleaseAuthorizationContractTest < Minitest::Test
  ROOT = File.expand_path("..", __dir__)

  def test_authorization_workflow_is_opt_in_and_uses_approved_action_pins
    workflow = File.read(File.join(ROOT, "templates", "release-android.yml"))

    assert_includes workflow, "ENABLE_GITHUB_RELEASE_DEPLOY"
    assert_match(/EVENT_NAME.*release.*ENABLE_GITHUB_RELEASE_DEPLOY.*true/m, workflow)
    assert_includes workflow, "confirm_dual_delivery:"
    assert_includes workflow, "confirm_play_release_policy:"
    assert_includes workflow, "confirm_slack_notification:"
    assert_includes workflow, "CONFIRM_PRODUCTION_DEPLOY"
    assert_includes workflow, "GITHUB_RUN_ATTEMPT"
    assert_match(/rerun.*reconcil/i, workflow)

    assert_includes workflow,
      "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0"
    assert_includes workflow,
      "actions/setup-java@0f481fcb613427c0f801b606911222b5b6f3083a # v5.5.0"
    assert_includes workflow,
      "ruby/setup-ruby@8e41b362d2589a22a44c1cfa214b3c83052c195b # v1.318.0"
  end

  def test_authorization_skill_completion_report_has_the_exact_approved_contract
    skill = File.read(File.join(ROOT, "SKILL.md"))
    headings = [
      "Global skill installation result",
      "Created skill files",
      "Current Flutter project changes",
      "Detected project information",
      "Values the user must prepare",
      "Local validation commands",
      "GitHub Secrets",
      "Deployment commands",
      "Validation results",
      "Cautions"
    ]

    headings.each { |heading| assert_includes skill, heading }
    %w[Created Modified Preserved Backup].each { |subgroup| assert_includes skill, subgroup }
    %w[PASS WARN FAIL].each { |status| assert_includes skill, status }
    assert_includes skill, "not run"
  end

  def test_authorization_environment_catalog_uses_git_commit_count_not_time_for_local_codes
    catalog = File.read(File.join(ROOT, "references", "environment-variables.md"))

    assert_includes catalog, "positive Git commit count"
    refute_match(/UTC fallback|bounded UTC/i, catalog)
  end

  def test_authorization_operator_docs_match_runtime_gates
    readme = File.read(File.join(ROOT, "README.md"))
    guide = File.read(File.join(ROOT, "templates", "PLAY_STORE_RELEASE.md"))
    troubleshooting = File.read(File.join(ROOT, "references", "troubleshooting.md"))

    [readme, guide].each do |document|
      assert_includes document, "ENABLE_GITHUB_RELEASE_DEPLOY=true"
      assert_includes document, "CONFIRM_DUAL_DELIVERY=true"
      assert_includes document, "CONFIRM_PLAY_RELEASE_POLICY=true"
      assert_match(/rerun.*never auto-notify|reruns.*suppress automatic Slack/i, document)
    end
    assert_includes troubleshooting, "CONFIRM_UPLOAD_RECONCILED=true"
    assert_match(/provider proves `not-delivered`/, troubleshooting)
    refute_match(/retry (?:the serialized upload )?once/i, troubleshooting)
  end

  def test_authorization_runtime_uses_strict_confirmation_for_every_external_gate
    runtime = File.read(File.join(ROOT, "templates", "FlutterPlayStoreRelease.rb"))
    gates = %w[
      CONFIRM_DUAL_DELIVERY
      CONFIRM_PRODUCTION_DEPLOY
      CONFIRM_FIREBASE_AAB_PLAY_LINKED
      CONFIRM_PLAY_RELEASE_POLICY
      CONFIRM_UPLOAD_RECONCILED
      CONFIRM_FIREBASE_PACKAGE_MATCH
      CONFIRM_SLACK_NOTIFICATION
    ]

    gates.each do |gate|
      assert_match(/confirmed\?\((?:env|environment)\["#{gate}"\]\)/, runtime,
        "#{gate} is not guarded by the strict confirmation predicate")
      refute_match(/truthy\?\((?:env|environment)\["#{gate}"\]\)/, runtime,
        "#{gate} still accepts broad truthy aliases")
    end
  end
end

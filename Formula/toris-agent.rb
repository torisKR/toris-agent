class TorisAgent < Formula
  desc "Terminal development harness for solo builders"
  homepage "https://github.com/torisKR/toris-agent"
  url "https://github.com/torisKR/toris-agent/releases/download/v0.5.1/toris-agent-0.5.1.tgz"
  version "0.5.1"
  sha256 "b1f095868937f88b785fe394c78c029b36a1f91835a35405de20af2f26860a76"
  license "Apache-2.0"

  depends_on "node"

  def install
    libexec.install Dir["*"]
    (bin/"toris").write <<~SH
      #!/bin/sh
      exec "#{Formula["node"].opt_bin}/node" "#{libexec}/bin/toris.js" "$@"
    SH
    chmod 0755, bin/"toris"
  end

  test do
    require "json"

    info = JSON.parse(shell_output("#{bin}/toris --version --json"))
    assert_equal "toris-agent", info.fetch("name")
    assert_equal version.to_s, info.fetch("version")

    home = testpath/"toris-home"
    init = JSON.parse(shell_output("#{bin}/toris init --solo --json --home '#{home}'"))
    assert_equal true, init.fetch("ok")
    assert_equal home.to_s, init.fetch("home")
    assert_equal testpath.realpath.to_s, init.fetch("solo").fetch("project").fetch("path")
    assert_equal "L2", init.fetch("solo").fetch("autonomy")
    assert_equal "manual", init.fetch("solo").fetch("apply")
    assert_path_exists home/"config.json"

    result = JSON.parse(shell_output("#{bin}/toris run 'add a health endpoint' --offline --dry-run --json --home '#{home}'"))
    assert_equal true, result.fetch("ok")
    run = result.fetch("run")
    assert_equal "dry-run", run.fetch("status")
    assert_equal false, run.fetch("providerAvailable")
    assert_equal 0, run.fetch("costUsd")
    refute_empty run.fetch("tasks")
    assert_equal init.fetch("solo").fetch("project").fetch("id"), run.fetch("projectId")
  end
end

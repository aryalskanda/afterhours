# Template: the release workflow fills in {{repo}}, {{version}} and the checksums, attaches the
# result to the GitHub release, and (with HOMEBREW_TAP_TOKEN) commits it to <owner>/homebrew-tap.
# People then install with: brew install <owner>/tap/afterhours
class Afterhours < Formula
  desc "Queue Claude Code tasks from your phone and run them on your Mac"
  homepage "https://github.com/{{repo}}"
  version "{{version}}"
  license "Apache-2.0"

  on_arm do
    url "https://github.com/{{repo}}/releases/download/v{{version}}/cq-darwin-arm64"
    sha256 "{{sha256_arm64}}"
  end
  on_intel do
    url "https://github.com/{{repo}}/releases/download/v{{version}}/cq-darwin-x64"
    sha256 "{{sha256_x64}}"
  end

  depends_on :macos
  depends_on "tmux"

  def install
    bin.install Dir["cq-darwin-*"].first => "cq"
  end

  def caveats
    <<~EOS
      Finish setting up (your code folders, the background service, Full Disk Access and Telegram):
        cq setup

      Afterhours runs Claude Code with your own Claude sign-in. It is not made by or affiliated with Anthropic.
    EOS
  end

  test do
    assert_equal version.to_s, shell_output("#{bin}/cq version").strip
  end
end

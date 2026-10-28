# Template: the release workflow fills in {{repo}}, {{version}} and the checksums, attaches the
# result to the GitHub release, and (with HOMEBREW_TAP_TOKEN) commits it to <owner>/homebrew-tap.
# People then install with: brew install <owner>/tap/afterhours   (macOS and Linux)
class Afterhours < Formula
  desc "Queue Claude Code tasks from Telegram and run them on your computer while you're away"
  homepage "https://github.com/{{repo}}"
  version "{{version}}"
  license "Apache-2.0"

  on_macos do
    on_arm do
      url "https://github.com/{{repo}}/releases/download/v{{version}}/cq-darwin-arm64"
      sha256 "{{sha256_darwin_arm64}}"
    end
    on_intel do
      url "https://github.com/{{repo}}/releases/download/v{{version}}/cq-darwin-x64"
      sha256 "{{sha256_darwin_x64}}"
    end
  end
  on_linux do
    on_arm do
      url "https://github.com/{{repo}}/releases/download/v{{version}}/cq-linux-arm64"
      sha256 "{{sha256_linux_arm64}}"
    end
    on_intel do
      url "https://github.com/{{repo}}/releases/download/v{{version}}/cq-linux-x64"
      sha256 "{{sha256_linux_x64}}"
    end
  end

  depends_on "tmux"

  def install
    bin.install Dir["cq-*"].first => "cq"
  end

  def caveats
    <<~EOS
      Finish setting up (your code folders, the background service and your Telegram bot):
        cq setup

      Afterhours runs Claude Code with your own Claude sign-in. Install it first if you haven't:
        curl -fsSL https://claude.ai/install.sh | bash

      Afterhours is not made by or affiliated with Anthropic.
    EOS
  end

  test do
    assert_equal version.to_s, shell_output("#{bin}/cq version").strip
  end
end

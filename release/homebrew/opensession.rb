class Opensession < Formula
  desc "Unified terminal session manager for AI coding clients"
  homepage "https://github.com/josiahwiebe/opensession"
  version "0.1.0"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/josiahwiebe/opensession/releases/download/v#{version}/opensession-v#{version}-darwin-arm64.tar.gz"
      sha256 "REPLACE_DARWIN_ARM64_SHA256"
    else
      url "https://github.com/josiahwiebe/opensession/releases/download/v#{version}/opensession-v#{version}-darwin-x64.tar.gz"
      sha256 "REPLACE_DARWIN_X64_SHA256"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/josiahwiebe/opensession/releases/download/v#{version}/opensession-v#{version}-linux-arm64.tar.gz"
      sha256 "REPLACE_LINUX_ARM64_SHA256"
    else
      url "https://github.com/josiahwiebe/opensession/releases/download/v#{version}/opensession-v#{version}-linux-x64.tar.gz"
      sha256 "REPLACE_LINUX_X64_SHA256"
    end
  end

  def install
    bin.install "opensession"
    bin.install_symlink "opensession" => "ops"
  end

  test do
    output = shell_output("#{bin}/opensession --version")
    assert_match version.to_s, output
  end
end

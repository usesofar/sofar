# Homebrew formula for the sofar CLI.
#
# Publish by copying into a public tap repo as Formula/sofar.rb —
# users then run:
#   brew install <owner>/tap/sofar
#
# NOT destined for homebrew-core: core's notability bar (~75 stars /
# 30 forks / 30 watchers) is well above where jithinio/sofar sits. A
# custom tap has no such bar and installs identically; promoting this
# same formula into core later is a small step if traction arrives.
#
# Source of truth is the npm tarball, not a GitHub release tarball —
# the repo cuts no GitHub releases, and the registry tarball is
# immutable and already the artifact users get from npm/bun/pnpm. One
# artifact, four install paths.
#
# Bump with ./update-formula.sh <version> after each npm publish.
class Sofar < Formula
  desc "Event-sourced initiative memory for coding agents"
  homepage "https://sofar.sh"
  url "https://registry.npmjs.org/sofar.sh/-/sofar.sh-0.11.0.tgz"
  sha256 "e17e898b0c1dcc3d947bdf2418fec69d7c69115d098f56b2cb4b6a07cfd71114"
  license "MIT"

  livecheck do
    url "https://registry.npmjs.org/sofar.sh/latest"
    strategy :json do |json|
      json["version"]
    end
  end

  # dist/cli.js is fully bundled with zero runtime dependencies, so node
  # is the only thing needed at run time.
  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/sofar --version")

    # Fold a real record: init must scaffold .sofar/ and status must
    # read it back. Catches a bundle that resolves but cannot run.
    system bin/"sofar", "init", "--agents", "claude-code"
    assert_predicate testpath/".sofar", :directory?
  end
end

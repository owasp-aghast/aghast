const fs = require('fs');

const args = process.argv.slice(2);
const flags = new Set(args.filter(a => a.startsWith('--')));
const positional = args.filter(a => !a.startsWith('--'));
const version = positional[0];
const isPrerelease = flags.has('--prerelease');

if (!version) {
  console.error('Usage: node update-version-refs.cjs <version> [--prerelease]');
  process.exit(1);
}

// Update package.json
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf-8'));
pkg.version = version;
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');

// Update package-lock.json version to match
const lockPath = 'package-lock.json';
const lock = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
lock.version = version;
if (lock.packages && lock.packages['']) {
  lock.packages[''].version = version;
}
fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');

// Prereleases do not move the documented install command or the release.yml
// input description — those both track the latest stable version.
if (isPrerelease) {
  process.exit(0);
}

// Update version references in docs
for (const file of ['docs/getting-started.md']) {
  let content = fs.readFileSync(file, 'utf-8');
  content = content.replace(
    /@owasp-aghast\/aghast@[0-9]+\.[0-9]+\.[0-9]+/g,
    '@owasp-aghast/aghast@' + version
  );
  fs.writeFileSync(file, content);
}

// Update release workflow description with next possible versions
const [major, minor, patch] = version.split('.').map(Number);
const nextPatch = `${major}.${minor}.${patch + 1}`;
const nextMinor = `${major}.${minor + 1}.0`;
const nextMajor = `${major + 1}.0.0`;
const releaseYml = fs.readFileSync('.github/workflows/release.yml', 'utf-8');
const updatedYml = releaseYml.replace(
  /description: 'Release version \(e\.g\. [^']+\)'/,
  `description: 'Release version (e.g. ${nextPatch}, ${nextMinor}, ${nextMajor})'`
);
fs.writeFileSync('.github/workflows/release.yml', updatedYml);

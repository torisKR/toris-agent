export const STUDIO_SERVICE_LABEL = 'kr.toris.agent.studio';

function xml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

export function generateLaunchAgent(options) {
  const args = [options.nodePath, options.binPath, 'studio', '--home', options.torisHome];
  const argumentXml = args.map((value) => `      <string>${xml(value)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${STUDIO_SERVICE_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${argumentXml}
    </array>
    <key>WorkingDirectory</key>
    <string>${xml(options.workingDirectory)}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ProcessType</key>
    <string>Interactive</string>
    <key>StandardOutPath</key>
    <string>${xml(`${options.logDirectory}/studio.out.log`)}</string>
    <key>StandardErrorPath</key>
    <string>${xml(`${options.logDirectory}/studio.err.log`)}</string>
    <key>Umask</key>
    <integer>63</integer>
  </dict>
</plist>
`;
}

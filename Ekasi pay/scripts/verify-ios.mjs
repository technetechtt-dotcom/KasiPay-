import { existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const required = [
  'ios/App/App.xcodeproj/project.pbxproj',
  'ios/App/App/Info.plist',
  'ios/App/Podfile',
];

const missing = required.filter((rel) => !existsSync(join(root, rel)));
if (missing.length > 0) {
  console.error('iOS Capacitor project is incomplete. Missing:');
  for (const path of missing) console.error(`  - ${path}`);
  process.exit(1);
}

console.log('iOS Capacitor project structure verified.');

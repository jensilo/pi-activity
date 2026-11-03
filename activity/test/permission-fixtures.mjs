// Synthetic, inert candidates. Never execute these commands or read their referenced files.
export const questionSource = "/trusted/question/index.ts";
export const migrationQuestion = {
  header: "Extension migration",
  question: "May I move the duplicate ~/.pi/agent/extensions/synthetic-activity fixture symlink into a backup, while keeping the installed byte-identical activity guard enabled?",
  options: [
    { label: "Migrate the old symlink", description: "Back up only the duplicate fixture symlink. Keep the registered packaged guard active and finish installation tests." },
    { label: "Keep the old setup", description: "Do not move the symlink." },
  ],
};
export const migrationInput = { command: `python3 - <<'PY'
from pathlib import Path
import json,hashlib
home=Path.home();old=home/'.pi/agent/extensions/synthetic-activity';new=home/'.pi/agent/packages/synthetic-activity/activity'
assert old.is_symlink() and old.resolve()==Path('/synthetic/extension/activity')
settings=json.loads((home/'.pi/agent/settings.json').read_text())
assert 'packages/synthetic-activity' in settings.get('packages',[])
for source in old.glob('*.ts'):
 installed=new/source.name
 assert installed.is_file() and hashlib.sha256(source.read_bytes()).digest()==hashlib.sha256(installed.read_bytes()).digest(),source.name
backup=home/'.pi/agent/backups/synthetic-activity/fixture/activity-extension-link'
assert not backup.exists() and not backup.is_symlink()
old.rename(backup)
print('Duplicate backed up; installed activity guard remains enabled.')
PY` };
export function migrationAnswer(comment) {
  return { cancelled: false, answers: [{ questionIndex: 0, header: migrationQuestion.header, question: migrationQuestion.question,
    kind: "option", answer: "Migrate the old symlink", ...(comment ? { comment } : {}) }] };
}

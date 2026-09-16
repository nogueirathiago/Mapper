#!/usr/bin/env node
// Smoke test do transporte de marcas pelo installer.
//
// O installer (lib/installer/writer.js) instala cada skill com
// cpSync(src, dest, { recursive: true }). Este teste exercita esse mesmo
// mecanismo numa pasta temporária e confirma que as DUAS marcas do eixo de
// invocação sobrevivem à cópia — a flag disable-model-invocation no SKILL.md
// e o policy.allow_implicit_invocation no agents/openai.yaml. É o que garante
// que a economia de contexto vale também na máquina do usuário, não só na fonte.
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SKILL = 'reversa-scout'; // user-invoked representativo
const src = join(ROOT, 'agents', SKILL);

const tmp = mkdtempSync(join(tmpdir(), 'reversa-transport-'));
let failures = 0;
const check = (cond, msg) => { if (!cond) { console.error(`  ✗ ${msg}`); failures++; } else { console.log(`  ✓ ${msg}`); } };

try {
  const dest = join(tmp, SKILL);
  cpSync(src, dest, { recursive: true });

  const skill = readFileSync(join(dest, 'SKILL.md'), 'utf8');
  check(/^disable-model-invocation:\s*true\s*$/m.test(skill),
    'flag disable-model-invocation atravessou para o SKILL.md instalado');

  const yaml = readFileSync(join(dest, 'agents', 'openai.yaml'), 'utf8');
  check(/^\s*allow_implicit_invocation:\s*false\s*$/m.test(yaml),
    'policy.allow_implicit_invocation atravessou no agents/openai.yaml instalado');
  check(/display_name:/.test(yaml),
    'interface.display_name presente no openai.yaml instalado');

  const reversaDest = join(tmp, 'reversa');
  cpSync(join(ROOT, 'agents', 'reversa'), reversaDest, { recursive: true });
  const behavioralGuide = readFileSync(join(reversaDest, 'references', 'behavioral-analysis-guide.md'), 'utf8');
  check(/Guia de análise comportamental/.test(behavioralGuide),
    'método comportamental compartilhado atravessou para a instalação');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(failures ? `\nRESULTADO: ✗ ${failures} falha(s)` : '\nRESULTADO: ✓ transporte íntegro');
process.exit(failures ? 1 : 0);

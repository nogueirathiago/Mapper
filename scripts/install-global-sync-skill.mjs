#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { installGlobalSyncSkill } from '../lib/sync/global-skill.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const installed = installGlobalSyncSkill({ sourceRoot: repoRoot, forkPath: repoRoot });
console.log(`Skill instalada em: ${installed.activeSkill}`);
console.log(`Link de descoberta: ${installed.discoveryLink}`);
console.log(`Configuração: ${installed.configPath}`);


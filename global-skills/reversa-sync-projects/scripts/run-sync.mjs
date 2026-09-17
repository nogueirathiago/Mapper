#!/usr/bin/env node
import { loadRuntime, runForkCommand } from './runtime.mjs';

const { forkPath } = loadRuntime();
process.exit(runForkCommand(['sync-projects'], { cwd: forkPath }));

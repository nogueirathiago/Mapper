#!/usr/bin/env node
import { assertOnNeoMatrix, runForkCommand } from './runtime.mjs';

const projectRoot = assertOnNeoMatrix(process.cwd());
process.exit(runForkCommand(['register-project', projectRoot], { cwd: projectRoot }));

import path from 'node:path';
import { executeTransaction } from './update-transaction';
// The copied native bootstrap invokes this fixed script without renderer input.
executeTransaction(path.resolve(__dirname)).catch(() => { process.exitCode = 1; });

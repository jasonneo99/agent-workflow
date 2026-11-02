import assert from 'node:assert/strict';
import test from 'node:test';
import {verificationCommandsFirst} from './verification-command-order.js';

test('declared candidate checks run before additional suites that can exhaust the verifier retry loop',()=>{
 const focused='python3 -m unittest discover -s tests -p test_widget.py -v',broad='python3 -m unittest discover -s tests';
 assert.deepEqual(verificationCommandsFirst([broad,focused],[focused]),[focused,broad]);
 assert.deepEqual(verificationCommandsFirst([broad,focused,focused],[focused]),[focused,broad]);
 assert.deepEqual(verificationCommandsFirst([broad],[focused]),[broad],'A withheld command is never inserted by declaration');
 assert.deepEqual(verificationCommandsFirst([broad],[]),[broad]);
});

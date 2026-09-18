import assert from 'node:assert/strict';
import { cameraSourceId } from './cameraSourceId.js';
const registered = (id: string) => ['front', 'back'].includes(id);
assert.equal(cameraSourceId({id: 'Camera', owner: {id: 'front'}}, registered), 'front');
assert.equal(cameraSourceId({id: 'Camera', owner: {id: 'back'}}, registered), 'back');
assert.equal(cameraSourceId({id: 'front'}, registered), 'front');
assert.equal(cameraSourceId({id: 'missing'}, registered), 'missing');
console.log('Camera source resolution: 4 checks passed');

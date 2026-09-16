import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MatterbridgeCameraPlatform } from './module.js';
import { type MatterbridgeEndpoint } from 'matterbridge';
import { CameraRequirements, DoorbellRequirements } from 'matterbridge/matter/devices';
import { Switch } from 'matterbridge/matter/clusters';

test('VideoDoorbell composes Camera and Doorbell; preserves RTSP stream ID', async () => {
  // Exercise the real endpoint factory without starting go2rtc or a platform.
  const platform = Object.create(MatterbridgeCameraPlatform.prototype);
  platform.config = { debug: false };
  platform.doorbells = new Map();
  const root: MatterbridgeEndpoint = platform.createCameraEndpoint({ id: 'urmet', name: 'Urmet', rtspUrl: 'rtsp://example.invalid/live', videoDoorbell: true });
  assert(root.getDeviceTypes().some(type => type.code === 0x143));
  const camera = root.getChildEndpointById('urmet')!;
  const button = root.getChildEndpointById('urmet-doorbell')!;
  assert(camera.getDeviceTypes().some(type => type.code === 0x142));
  assert(button.getDeviceTypes().some(type => type.code === 0x148));
  assert(camera.behaviors.has(CameraRequirements.WebRtcTransportRequestorClient));
  assert(button.behaviors.has(DoorbellRequirements.ChimeClient));
  assert(button.hasClusterServer(Switch.id));
  assert.equal(platform.doorbells.get('urmet'), button);
});

test('ordinary camera remains unchanged and has no ring target', async () => {
  const platform = Object.create(MatterbridgeCameraPlatform.prototype);
  platform.config = { debug: false };
  platform.doorbells = new Map();
  const root: MatterbridgeEndpoint = platform.createCameraEndpoint({ id: 'camera', name: 'Camera', rtspUrl: 'rtsp://example.invalid/live' });
  assert(root.getDeviceTypes().some(type => type.code === 0x142));
  assert(!root.getDeviceTypes().some(type => type.code === 0x143));
  assert.equal(root.id, 'camera');
  assert.equal(platform.doorbells.size, 0);
});

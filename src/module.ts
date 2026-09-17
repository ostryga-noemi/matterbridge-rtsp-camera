import {
  bridgedNode,
  camera,
  doorbell,
  videoDoorbell,
  MatterbridgeDynamicPlatform,
  MatterbridgeEndpoint,
  type PlatformConfig,
  type PlatformMatterbridge,
} from 'matterbridge';
import type { AnsiLogger } from 'matterbridge/logger';
import { CameraRequirements, DoorbellRequirements } from 'matterbridge/matter/devices';
import { Go2RTCClient } from './streaming/Go2RTCClient.js';
import { MatterCameraAvStreamManagementServer } from './matter/behaviors/MatterCameraAvStreamManagementServer.js';
import { MatterWebRtcTransportProviderServer } from './matter/behaviors/MatterWebRtcTransportProviderServer.js';
import { streamContext } from './matter/behaviors/streamContext.js';
import { cameraAvStreamDefaults } from './matter/devices/cameraAvStreamDefaults.js';
import { HomeKitCameraPublisher, homeKitStoragePath } from './HomeKitCameraPublisher.js';
import { RingServer, type RingServerConfig } from './RingServer.js';

export type CameraProtocol = 'matter' | 'homekit';
export interface CameraConfig { id: string; name: string; rtspUrl: string; videoDoorbell?: boolean; }
export interface CameraPlatformConfig extends PlatformConfig { mode?: CameraProtocol; go2rtcUrl?: string; homekitPin?: string; ringServer?: RingServerConfig; cameras: CameraConfig[]; }

export default function initializePlugin(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: PlatformConfig): MatterbridgeCameraPlatform {
  return new MatterbridgeCameraPlatform(matterbridge, log, config as CameraPlatformConfig);
}

export class MatterbridgeCameraPlatform extends MatterbridgeDynamicPlatform {
  private readonly mode: CameraProtocol;
  private readonly go2rtc?: Go2RTCClient;
  private homekit?: HomeKitCameraPublisher;
  private ringServer?: RingServer;
  private readonly doorbells = new Map<string, MatterbridgeEndpoint>();
  private readonly roots = new Map<string, MatterbridgeEndpoint>();
  private readonly cameraChildren = new Map<string, MatterbridgeEndpoint>();

  constructor(matterbridge: PlatformMatterbridge, log: AnsiLogger, override config: CameraPlatformConfig) {
    super(matterbridge, log, config);
    if (!this.verifyMatterbridgeVersion('3.10.9')) throw new Error('matterbridge-rtsp-camera doorbell build requires Matterbridge 3.10.9 or newer');
    this.mode = config.mode ?? 'matter';
    if (this.mode !== 'matter' && this.mode !== 'homekit') throw new Error('mode must be either matter or homekit');
    if (this.mode === 'matter') {
      if (!config.go2rtcUrl?.trim()) throw new Error('go2rtcUrl is required in Matter mode');
      this.go2rtc = new Go2RTCClient(config.go2rtcUrl);
      streamContext.go2rtc = this.go2rtc;
    } else this.homekit = new HomeKitCameraPublisher(homeKitStoragePath(matterbridge.homeDirectory), config.homekitPin ?? '031-45-154', log);
  }

  override async onStart(reason?: string): Promise<void> {
    try {
      await this.ready;
      this.log.info(`Starting ${this.config.name}: ${reason ?? 'startup'}`);
      const cameras = (this.config.cameras ?? []).map(c => this.validateCameraConfig(c));
      const cameraIds = new Set<string>();
      for (const c of cameras) { if (cameraIds.has(c.id)) throw new Error(`Camera id ${c.id} is configured more than once`); cameraIds.add(c.id); }
      if (this.mode === 'homekit' && (cameras.some(c => c.videoDoorbell) || this.config.ringServer?.enabled)) throw new Error('Video Doorbell and external ring triggers require Matter mode');
      if (this.config.ringServer?.enabled) {
        this.ringServer = new RingServer(this.config.ringServer, async id => {
          const button = this.doorbells.get(id);
          if (!button) return 'not-found';
          this.logEndpointDiagnostics(id, button);
          const ok = await button.triggerSwitchEvent('Single', this.log);
          this.log.info(`[doorbell-ring] ${id} triggerSwitchEvent=${ok}`);
          return ok ? 'ok' : 'unavailable';
        });
      }
      if (this.mode === 'homekit') { await this.homekit!.start(cameras); return; }
      await this.go2rtc!.waitUntilReady(10, 1_000);
      for (const c of cameras) {
        this.go2rtc.registerDirectSource(c.id, c.name, c.rtspUrl);
        const endpoint = this.createCameraEndpoint(c);
        this.roots.set(c.id, endpoint);
        await this.registerDevice(endpoint);
        this.logEndpointDiagnostics(c.id, this.doorbells.get(c.id));
        this.setSelectDevice(c.id, c.name);
      }
      await this.ringServer?.start();
    } catch (error) {
      const detail = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ''}` : String(error);
      this.log.error(`[doorbell-startup-error] ${detail}`);
      throw error;
    }
  }

  private logEndpointDiagnostics(id: string, button?: MatterbridgeEndpoint): void {
    const root = this.roots.get(id); const cameraChild = this.cameraChildren.get(id);
    const describe = (endpoint?: MatterbridgeEndpoint): string => {
      if (!endpoint) return 'missing';
      const ep = endpoint as MatterbridgeEndpoint & { lifecycle?: { isReady?: boolean; isInstalled?: boolean; isActive?: boolean; isDestroyed?: boolean } };
      const lifecycle = ep.lifecycle;
      return `id=${endpoint.maybeId ?? endpoint.id} number=${endpoint.maybeNumber ?? 'none'} mode=${endpoint.mode ?? 'default'} lifecycle=${lifecycle ? JSON.stringify({ ready: lifecycle.isReady, installed: lifecycle.isInstalled, active: lifecycle.isActive, destroyed: lifecycle.isDestroyed }) : 'unavailable'}`;
    };
    this.log.warn(`[doorbell-diag] ${id} root{${describe(root)}} camera{${describe(cameraChild)}} doorbell{${describe(button)}}`);
  }

  private validateCameraConfig(c: CameraConfig): CameraConfig {
    const id = c.id.trim(), name = c.name.trim(), rtspUrl = c.rtspUrl.trim();
    if (!id || !name || !rtspUrl) throw new Error('Each camera requires non-empty id, name, and rtspUrl values');
    if (!rtspUrl.startsWith('rtsp://') && !rtspUrl.startsWith('rtsps://')) throw new Error(`Camera ${id} has an unsupported stream URL`);
    if (c.videoDoorbell !== undefined && typeof c.videoDoorbell !== 'boolean') throw new Error(`Camera ${id}: videoDoorbell must be a boolean`);
    return { id, name, rtspUrl, videoDoorbell: c.videoDoorbell ?? false };
  }

  private createCameraEndpoint(c: CameraConfig): MatterbridgeEndpoint {
    const { id, name } = c;
    if (c.videoDoorbell) {
      // Chapter-16 composite devices are native Matter functionality. Marking the
      // composed root as mode:matter prevents registerDevice() from rewriting it
      // into a legacy Bridged Node, while retaining the official Camera/Doorbell tree.
      const endpoint = new MatterbridgeEndpoint([videoDoorbell], { id, mode: 'matter' });
      endpoint.createDefaultBasicInformationClusterServer(name, id.slice(0, 32), 0xfff1, 'Matterbridge', 0x8000, 'RTSP Video Doorbell');
      endpoint.addRequiredClusters();
      const cameraEndpoint = endpoint.addChildDeviceType('Camera', camera, {});
      cameraEndpoint.log.logName = 'Camera';
      cameraEndpoint.behaviors.inject(MatterCameraAvStreamManagementServer, cameraAvStreamDefaults());
      cameraEndpoint.behaviors.inject(MatterWebRtcTransportProviderServer);
      cameraEndpoint.behaviors.inject(CameraRequirements.WebRtcTransportRequestorClient);
      cameraEndpoint.addRequiredClusters();
      const button = endpoint.addChildDeviceType('Doorbell', doorbell, {});
      button.log.logName = 'Doorbell';
      button.createDefaultIdentifyClusterServer();
      button.createDefaultMomentarySwitchClusterServer();
      button.behaviors.require(DoorbellRequirements.ChimeClient);
      button.addRequiredClusters();
      this.cameraChildren.set(id, cameraEndpoint); this.doorbells.set(id, button); return endpoint;
    }
    const endpoint = new MatterbridgeEndpoint([camera, bridgedNode], { id }, this.config.debug)
      .createDefaultBridgedDeviceBasicInformationClusterServer(name, id.slice(0, 32), 0xfff1, 'Matterbridge Camera', 'RTSP Camera').addRequiredClusterServers();
    endpoint.behaviors.inject(MatterCameraAvStreamManagementServer, cameraAvStreamDefaults());
    endpoint.behaviors.inject(MatterWebRtcTransportProviderServer);
    endpoint.behaviors.inject(CameraRequirements.WebRtcTransportRequestorClient);
    this.cameraChildren.set(id, endpoint); return endpoint;
  }

  override async onShutdown(reason?: string): Promise<void> {
    this.log.info(`Stopping ${this.config.name}: ${reason ?? 'shutdown'}`);
    await this.ringServer?.stop(); this.doorbells.clear(); this.roots.clear(); this.cameraChildren.clear(); await this.homekit?.stop(); await super.onShutdown(reason);
  }
}

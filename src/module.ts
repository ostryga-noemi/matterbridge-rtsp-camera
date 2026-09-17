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

export interface CameraConfig {
  id: string;
  name: string;
  rtspUrl: string;
  videoDoorbell?: boolean;
}

export interface CameraPlatformConfig extends PlatformConfig {
  mode?: CameraProtocol;
  go2rtcUrl?: string;
  homekitPin?: string;
  ringServer?: RingServerConfig;
  cameras: CameraConfig[];
}

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
    } else {
      this.homekit = new HomeKitCameraPublisher(homeKitStoragePath(matterbridge.homeDirectory), config.homekitPin ?? '031-45-154', log);
    }
  }

  override async onStart(reason?: string): Promise<void> {
    try {
      await this.ready;
      this.log.info(`Starting ${this.config.name}: ${reason ?? 'startup'}`);
      const cameras = (this.config.cameras ?? []).map(cameraConfig => this.validateCameraConfig(cameraConfig));
      const cameraIds = new Set<string>();
      for (const cameraConfig of cameras) {
        if (cameraIds.has(cameraConfig.id)) throw new Error(`Camera id ${cameraConfig.id} is configured more than once`);
        cameraIds.add(cameraConfig.id);
      }
      if (this.mode === 'homekit' && (cameras.some(cameraConfig => cameraConfig.videoDoorbell) || this.config.ringServer?.enabled)) throw new Error('Video Doorbell and external ring triggers require Matter mode');
      if (this.config.ringServer?.enabled) {
        this.ringServer = new RingServer(this.config.ringServer, async id => {
          const button = this.doorbells.get(id);
          if (!button) return 'not-found';
          this.logEndpointDiagnostics(id, button);
          return await button.triggerSwitchEvent('Single', this.log) ? 'ok' : 'unavailable';
        });
      }
      if (this.mode === 'homekit') {
        await this.homekit!.start(cameras);
        return;
      }
      await this.go2rtc!.waitUntilReady(10, 1_000);
      for (const cameraConfig of cameras) {
        this.go2rtc.registerDirectSource(cameraConfig.id, cameraConfig.name, cameraConfig.rtspUrl);
        const endpoint = this.createCameraEndpoint(cameraConfig);
        this.roots.set(cameraConfig.id, endpoint);
        await this.registerDevice(endpoint);
        this.logEndpointDiagnostics(cameraConfig.id, this.doorbells.get(cameraConfig.id));
        this.setSelectDevice(cameraConfig.id, cameraConfig.name);
      }
      await this.ringServer?.start();
    } catch (error) {
      const detail = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ''}` : String(error);
      this.log.error(`[doorbell-startup-error] ${detail}`);
      throw error;
    }
  }

  private logEndpointDiagnostics(id: string, button?: MatterbridgeEndpoint): void {
    const root = this.roots.get(id);
    const cameraChild = this.cameraChildren.get(id);
    const describe = (endpoint?: MatterbridgeEndpoint): string => {
      if (!endpoint) return 'missing';
      const ep = endpoint as MatterbridgeEndpoint & { lifecycle?: { isReady?: boolean; isInstalled?: boolean; isActive?: boolean; isDestroyed?: boolean } };
      const lifecycle = ep.lifecycle;
      return `id=${endpoint.maybeId ?? endpoint.id} number=${endpoint.maybeNumber ?? 'none'} lifecycle=${lifecycle ? JSON.stringify({ ready: lifecycle.isReady, installed: lifecycle.isInstalled, active: lifecycle.isActive, destroyed: lifecycle.isDestroyed }) : 'unavailable'}`;
    };
    this.log.warn(`[doorbell-diag] ${id} root{${describe(root)}} camera{${describe(cameraChild)}} doorbell{${describe(button)}}`);
  }

  private validateCameraConfig(cameraConfig: CameraConfig): CameraConfig {
    const id = cameraConfig.id.trim();
    const name = cameraConfig.name.trim();
    const rtspUrl = cameraConfig.rtspUrl.trim();
    if (!id || !name || !rtspUrl) throw new Error('Each camera requires non-empty id, name, and rtspUrl values');
    if (!rtspUrl.startsWith('rtsp://') && !rtspUrl.startsWith('rtsps://')) throw new Error(`Camera ${id} has an unsupported stream URL`);
    if (cameraConfig.videoDoorbell !== undefined && typeof cameraConfig.videoDoorbell !== 'boolean') throw new Error(`Camera ${id}: videoDoorbell must be a boolean`);
    return { id, name, rtspUrl, videoDoorbell: cameraConfig.videoDoorbell ?? false };
  }

  private createCameraEndpoint(cameraConfig: CameraConfig): MatterbridgeEndpoint {
    const { id, name } = cameraConfig;
    if (cameraConfig.videoDoorbell) {
      // Matterbridge 3.10.9 contains the VideoDoorbell implementation but does not
      // export the VideoDoorbell class from matterbridge/devices. Compose the same
      // public device types here while retaining our custom RTSP camera behaviors.
      const endpoint = new MatterbridgeEndpoint([videoDoorbell], { id }, this.config.debug)
        .createDefaultBasicInformationClusterServer(name, id.slice(0, 32), 0xfff1, 'Matterbridge', 0x8000, 'RTSP Video Doorbell')
        .addRequiredClusterServers();

      const cameraEndpoint = endpoint.addChildDeviceType(id, camera, {});
      cameraEndpoint.behaviors.inject(MatterCameraAvStreamManagementServer, cameraAvStreamDefaults());
      cameraEndpoint.behaviors.inject(MatterWebRtcTransportProviderServer);
      cameraEndpoint.behaviors.inject(CameraRequirements.WebRtcTransportRequestorClient);
      cameraEndpoint.addRequiredClusterServers();

      const button = endpoint.addChildDeviceType(`${id}-doorbell`, doorbell, {});
      button.createDefaultMomentarySwitchClusterServer();
      button.behaviors.require(DoorbellRequirements.ChimeClient);
      button.addRequiredClusterServers();

      this.cameraChildren.set(id, cameraEndpoint);
      this.doorbells.set(id, button);
      return endpoint;
    }

    const endpoint = new MatterbridgeEndpoint([camera, bridgedNode], { id }, this.config.debug)
      .createDefaultBridgedDeviceBasicInformationClusterServer(name, id.slice(0, 32), 0xfff1, 'Matterbridge Camera', 'RTSP Camera')
      .addRequiredClusterServers();
    endpoint.behaviors.inject(MatterCameraAvStreamManagementServer, cameraAvStreamDefaults());
    endpoint.behaviors.inject(MatterWebRtcTransportProviderServer);
    endpoint.behaviors.inject(CameraRequirements.WebRtcTransportRequestorClient);
    this.cameraChildren.set(id, endpoint);
    return endpoint;
  }

  override async onShutdown(reason?: string): Promise<void> {
    this.log.info(`Stopping ${this.config.name}: ${reason ?? 'shutdown'}`);
    await this.ringServer?.stop();
    this.doorbells.clear();
    this.roots.clear();
    this.cameraChildren.clear();
    await this.homekit?.stop();
    await super.onShutdown(reason);
  }
}

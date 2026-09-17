import { resolveMatterEsm } from './sdkImport.js';

const { GlobalConfig, commandSupervisionConfigs } = await import(
    resolveMatterEsm('@matter/node', 'dist/esm/behavior/supervision/SupervisionConfig.js')
);

const WEBRTC_COMMANDS = ['provideOffer', 'solicitOffer', 'provideAnswer', 'provideIceCandidates'];

/** Disable strict TLV validation for WebRTC commands (SmartThings sends partial sFrameConfig). */
export function disableWebRtcCommandValidation(constructor: Function) {
    const prototype = constructor.prototype;
    let map = commandSupervisionConfigs.get(prototype);
    if (map === undefined) {
        map = new Map();
        commandSupervisionConfigs.set(prototype, map);
    }

    for (const method of WEBRTC_COMMANDS) {
        let config = map.get(method);
        if (config === undefined) {
            config = new GlobalConfig();
            map.set(method, config);
        }
        config.supervision ??= {};
        config.supervision.validate = false;
    }
}

/** Resolve a camera child to the configured RTSP source on its owning device. */
export function cameraSourceId(endpoint: { id: string; owner?: any }, isRegistered: (id: string) => boolean): string {
    for (let current = endpoint; current; current = current.owner) {
        const id = String(current.id);
        if (isRegistered(id)) return id;
    }
    return String(endpoint.id);
}

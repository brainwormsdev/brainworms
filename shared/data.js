// The model's input data: the published wiring (data/wiring.json) plus the transmitters model v2 reads
// (data/transmitters.json, from the lab's cell-type table). Both files' SHA-256 go into every log.
export const withTransmitters = (D, T) => ({ ...D, tx: T.cells });

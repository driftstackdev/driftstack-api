/** Room-scoped reliable-input congestion state shared by the capture hook and every
 * command wrapper that publishes on the same ordered LiveKit data channel. WeakSet
 * ownership means a torn-down Room is never retained merely for health bookkeeping. */
const congestedRooms = new WeakSet<object>();

export class ReliableInputCongestedError extends Error {
  constructor() {
    super('The reliable input channel is congested');
    this.name = 'ReliableInputCongestedError';
  }
}

export function setReliableInputCongested(room: object, congested: boolean): void {
  if (congested) congestedRooms.add(room);
  else congestedRooms.delete(room);
}

export function isReliableInputCongested(room: object): boolean {
  return congestedRooms.has(room);
}

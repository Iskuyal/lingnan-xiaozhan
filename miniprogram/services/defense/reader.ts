import { READER_MATERIALS } from './reader-data';
export type { ReaderMaterial, MaterialEntry } from './reader-data';

/** Read-only local content, derived from the server's canonical frozen source at build time. */
export function materialForReading(id: string) {
  return READER_MATERIALS.find(material => material.id === id) ?? null;
}

import { openSupervisedProcess } from './supervised-process.mjs';

export function openDshProcess(options) {
  return openSupervisedProcess({ ...options, label: 'DSH' });
}

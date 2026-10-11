// Iranian first names (English spelling) for agents; the look follows the name's gender.
import { hash } from './palette';
import type { Gender } from './character';

export const MALE = [
  'Kourosh', 'Arash', 'Dariush', 'Kian', 'Arman', 'Babak', 'Bahram', 'Farhad', 'Kaveh', 'Siavash', 'Sohrab', 'Rostam',
  'Pouya', 'Nima', 'Omid', 'Parsa', 'Ramin', 'Sam', 'Shahin', 'Behrouz', 'Jamshid', 'Bardia', 'Keyvan', 'Mehrdad',
];
export const FEMALE = [
  'Darya', 'Niloufar', 'Parisa', 'Sara', 'Shirin', 'Roya', 'Yasmin', 'Nasrin', 'Laleh', 'Mina', 'Tara', 'Setareh',
  'Parvaneh', 'Mahsa', 'Negar', 'Golnaz', 'Elham', 'Azita', 'Bahar', 'Shadi', 'Anahita', 'Mitra', 'Kimia', 'Nazanin',
];

/** Stable name for a key, skipping names already on screen. */
export function pickName(key: string, taken: Set<string>): { name: string; gender: Gender } {
  const h = hash(key);
  const gender: Gender = h & 1 ? 'f' : 'm';
  const list = gender === 'f' ? FEMALE : MALE;
  let i = (h >>> 1) % list.length;
  for (let n = 0; n < list.length && taken.has(list[i]); n++) i = (i + 1) % list.length;
  return { name: list[i], gender };
}

export function randomName(gender: Gender) {
  const list = gender === 'f' ? FEMALE : MALE;
  return list[Math.floor(Math.random() * list.length)];
}

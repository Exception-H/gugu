import { describe, expect, it } from 'vitest';
import { ELIDED_PICTURE, PictureElider, elidedBytes, type PictureFilter } from './picture-elider';

const BIG = 'A'.repeat(70 * 1024) + 'xyz/+=';
const lines = [
  `{"type":"x","text":"héllo 中文"}`,
  `{"image_url":"data:image/png;base64,${BIG}"}`,
  `{"source":{"type":"base64","media_type":"image/png","data":"${BIG}B"}}`,
  `{"image_url":"data:image/png;base64,short"}`,
  `{"text":"data:x;base64,${'A'.repeat(100)}\\n not a picture"}`,
];
const record = lines.join('\n') + '\n';

/** Feed `record` in pieces of `size` characters; collect what is passed on and what the filter was asked. */
function run(size: number, keep: (at: number) => boolean) {
  const asked: number[] = [], kept: number[] = [];
  const filter: PictureFilter = { keep: (at) => { asked.push(at); return keep(at); }, kept: (chars) => { kept.push(chars); } };
  const elider = new PictureElider(filter);
  elider.restart(0);
  let out = '';
  for (let at = 0; at < record.length; at += size) out += elider.write(record.slice(at, at + size));
  return { out, asked, kept };
}

const pictureStarts = [lines[0], lines[1]].reduce<number[]>((starts, _line, index) => {
  const before = Buffer.byteLength(lines.slice(0, index + 1).join('\n') + '\n', 'utf8');
  const line = lines[index + 1];
  const prefix = index === 0 ? ';base64,' : '"data":"';
  return [...starts, before + Buffer.byteLength(line.slice(0, line.indexOf(prefix) + prefix.length), 'utf8')];
}, []);

describe('picture elider', () => {
  it.each([1, 7, 1000, 64 * 1024, 1 << 20])('passes over long pictures read %i characters at a time, and nothing else', (size) => {
    const { out, asked, kept } = run(size, () => false);
    expect(out).toBe([
      lines[0],
      `{"image_url":"data:image/png;base64,${ELIDED_PICTURE}${BIG.length}"}`,
      `{"source":{"type":"base64","media_type":"image/png","data":"${ELIDED_PICTURE}${BIG.length + 1}"}}`,
      lines[3],
      lines[4],
    ].join('\n') + '\n');
    expect(asked).toEqual(pictureStarts);
    expect(kept).toEqual([]);
    // The record bytes stand where they were: each line's offset is recovered from what was passed on.
    expect(out.split('\n').reduce((bytes, line) => bytes + Buffer.byteLength(line, 'utf8') + 1 + elidedBytes(line), 0) - 1)
      .toBe(Buffer.byteLength(record, 'utf8'));
  });

  it.each([1, 7, 64 * 1024])('passes a kept picture on whole and reports its length (%i at a time)', (size) => {
    const { out, kept } = run(size, (at) => at === pictureStarts[1]);
    expect(out).toContain(`"data":"${BIG}B"`);
    expect(out).toContain(`base64,${ELIDED_PICTURE}${BIG.length}"`);
    expect(kept).toEqual([BIG.length + 1]);
  });

  it('starts over at a new read', () => {
    const elider = new PictureElider({ keep: () => false, kept: () => {} });
    elider.restart(0);
    expect(elider.write(`{"a":"data:x;base64,${'A'.repeat(70 * 1024)}`)).toBe('{"a":"data:x;base64,');
    elider.restart(500);
    expect(elider.write('{"b":1}\n')).toBe('{"b":1}\n');
  });
});

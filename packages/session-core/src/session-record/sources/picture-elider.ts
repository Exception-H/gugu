/**
 * A store fill's pictures (resume-tail): a picture's base64 is most of a large record, and joined into one JS string
 * per picture on the main process it is most of the memory a fill takes. The reader's text arrives a read at a time;
 * a long base64 run right after `;base64,` (a Codex `data:` URL) or `"data":"` (a Claude image source) is passed on
 * only when `keep` says so, otherwise replaced by `ELIDED_PICTURE` and its length — it never joins its line. Base64 is
 * ASCII: its characters are its record bytes. Reads without a filter are untouched.
 */
export type PictureFilter = {
  /** Whether the picture whose base64 starts at record byte `at` is kept. */
  keep(at: number): boolean;
  /** A kept picture's length in base64 characters, once its end is read. */
  kept(chars: number): void;
};

/** What an elided picture's base64 is replaced by: this prefix, then its length in characters. */
export const ELIDED_PICTURE = '!gugu-elided:';

/** Shorter runs are passed on as they are: a small picture costs little, and so does telling it from text. */
const MIN_PICTURE_CHARS = 64 * 1024;
const PREFIXES = [';base64,', '"data":"'];
const CARRY = Math.max(...PREFIXES.map((prefix) => prefix.length)) - 1;
const NOT_BASE64 = /[^A-Za-z0-9+/=]/;

/** The record bytes the elided pictures in `text` stood for beyond the text that replaced them. */
export function elidedBytes(text: string): number {
  if (!text.includes(ELIDED_PICTURE)) return 0;
  let bytes = 0;
  for (const match of text.matchAll(/!gugu-elided:(\d+)/g)) bytes += Number(match[1]) - match[0].length;
  return bytes;
}

/** How many characters at the end of `text` begin one of `PREFIXES`. */
function prefixStartAtEnd(text: string): number {
  for (let length = Math.min(CARRY, text.length); length > 0; length--) {
    if (PREFIXES.some((prefix) => prefix.startsWith(text.slice(-length)))) return length;
  }
  return 0;
}

export class PictureElider {
  private mode: 'scan' | 'probe' | 'skip' | 'pass' = 'scan';
  /** scan: a tail that may begin a prefix; probe: the run read so far. Neither has been passed on. */
  private held = '';
  /** Record offset of `held[0]`, and of the next text's first byte. */
  private heldAt = 0;
  private at = 0;
  private runAt = 0;
  private runChars = 0;

  constructor(private readonly filter: PictureFilter) {}

  /** The text that follows starts at record byte `at` (a new read). */
  restart(at: number): void {
    this.mode = 'scan'; this.held = ''; this.at = at;
  }

  /** The record's next text. Returns what is passed on. */
  write(text: string): string {
    const at = this.at;
    this.at += Buffer.byteLength(text, 'utf8');
    const merge = this.mode === 'scan' && this.held.length > 0;
    const data = merge ? this.held + text : text;
    const base = merge ? this.heldAt : at;
    if (merge) this.held = '';
    let out = '';
    let i = 0;
    while (i < data.length) {
      if (this.mode === 'scan') {
        let found = -1, length = 0;
        for (const prefix of PREFIXES) {
          const hit = data.indexOf(prefix, i);
          if (hit >= 0 && (found < 0 || hit < found)) { found = hit; length = prefix.length; }
        }
        if (found < 0) {
          // Hold back only a tail that begins a prefix: a read ending in a whole line must be passed on whole.
          const keepFrom = Math.max(i, data.length - prefixStartAtEnd(data));
          out += data.slice(i, keepFrom);
          this.held = data.slice(keepFrom);
          this.heldAt = base + Buffer.byteLength(data.slice(0, keepFrom), 'utf8');
          return out;
        }
        out += data.slice(i, found + length);
        i = found + length;
        this.mode = 'probe'; this.held = ''; this.runChars = 0;
        this.runAt = base + Buffer.byteLength(data.slice(0, i), 'utf8');
      } else if (this.mode === 'probe') {
        // Only base64 up to the threshold makes a picture; anything else goes on as it is.
        const window = data.slice(i, i + MIN_PICTURE_CHARS - this.held.length);
        const stop = window.search(NOT_BASE64);
        const probed = stop < 0 ? window : window.slice(0, stop);
        this.held += probed;
        i += probed.length;
        if (this.held.length >= MIN_PICTURE_CHARS) {
          this.runChars = this.held.length;
          if (this.filter.keep(this.runAt)) { out += this.held; this.mode = 'pass'; } else this.mode = 'skip';
          this.held = '';
        } else if (i < data.length) {
          out += this.held; this.held = '';
          this.mode = 'scan';
        }
      } else {
        // A picture's base64 has no quote: the run ends at the string's closing one.
        const end = data.indexOf('"', i);
        const stop = end < 0 ? data.length : end;
        if (this.mode === 'pass') out += data.slice(i, stop);
        this.runChars += stop - i;
        i = stop;
        if (end >= 0) {
          if (this.mode === 'skip') out += `${ELIDED_PICTURE}${this.runChars}`;
          else this.filter.kept(this.runChars);
          this.mode = 'scan';
        }
      }
    }
    return out;
  }
}

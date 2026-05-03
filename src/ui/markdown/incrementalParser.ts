// src/ui/markdown/incrementalParser.ts
export type Block =
  | { type: 'paragraph'; text: string }
  | { type: 'code'; language: string; text: string }
  | { type: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; text: string };

type ParserMode = 'normal' | 'code';

export class IncrementalMarkdownParser {
  private buffer = '';
  private mode: ParserMode = 'normal';
  private codeLang = '';
  private codeBuf = '';
  private completed: Block[] = [];

  feed(chunk: string): void {
    this.buffer += chunk;
    let progress = true;
    while (progress) {
      progress = false;
      if (this.mode === 'normal') {
        // Try to lock a heading line: requires a newline.
        if (this.buffer.startsWith('#')) {
          const nl = this.buffer.indexOf('\n');
          if (nl !== -1) {
            const line = this.buffer.slice(0, nl);
            const m = line.match(/^(#{1,6})\s+(.*)$/);
            if (m) {
              const hashes = m[1];
              const headingText = m[2];
              if (hashes === undefined || headingText === undefined) continue;
              this.completed.push({
                type: 'heading',
                level: hashes.length as 1 | 2 | 3 | 4 | 5 | 6,
                text: headingText,
              });
              this.buffer = this.buffer.slice(nl + 1).replace(/^\n+/, '');
              progress = true;
              continue;
            }
          }
        }
        // Try to enter code mode on opening fence at start of buffer.
        if (this.buffer.startsWith('```')) {
          const nl = this.buffer.indexOf('\n');
          if (nl !== -1) {
            this.codeLang = this.buffer.slice(3, nl).trim();
            this.buffer = this.buffer.slice(nl + 1);
            this.mode = 'code';
            this.codeBuf = '';
            progress = true;
            continue;
          }
        }
        // Lock a paragraph at the next blank line.
        const blank = this.buffer.indexOf('\n\n');
        if (blank !== -1) {
          const text = this.buffer.slice(0, blank).trim();
          if (text.length > 0) this.completed.push({ type: 'paragraph', text });
          this.buffer = this.buffer.slice(blank + 2);
          progress = true;
        }
      } else {
        // In code mode: look for closing fence.
        const fence = this.buffer.indexOf('```');
        if (fence !== -1) {
          this.codeBuf += this.buffer.slice(0, fence).replace(/\n$/, '');
          this.completed.push({ type: 'code', language: this.codeLang, text: this.codeBuf });
          this.buffer = this.buffer.slice(fence + 3).replace(/^\n+/, '');
          this.mode = 'normal';
          this.codeBuf = '';
          this.codeLang = '';
          progress = true;
        } else {
          // Move what we have into the code buffer; wait for more input.
          this.codeBuf += this.buffer;
          this.buffer = '';
        }
      }
    }
  }

  completedBlocks(): readonly Block[] {
    return this.completed;
  }

  openBlock(): Block | null {
    if (this.mode === 'code') {
      return { type: 'code', language: this.codeLang, text: this.codeBuf };
    }
    if (this.buffer.trim().length === 0) return null;
    return { type: 'paragraph', text: this.buffer.trim() };
  }
}

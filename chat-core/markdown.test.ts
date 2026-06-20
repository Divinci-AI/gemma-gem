import { describe, it, expect } from 'vitest'
import { renderMarkdown } from '@/chat-core/markdown'

describe('renderMarkdown — formatting', () => {
  it('bold + italic', () => {
    expect(renderMarkdown('**bold** and *italic*')).toBe('<p><strong>bold</strong> and <em>italic</em></p>')
    expect(renderMarkdown('__b__ and _i_')).toContain('<strong>b</strong>')
  })
  it('headings', () => {
    expect(renderMarkdown('# H1')).toBe('<h1>H1</h1>')
    expect(renderMarkdown('### H3')).toBe('<h3>H3</h3>')
  })
  it('unordered + ordered lists', () => {
    expect(renderMarkdown('- a\n- b')).toBe('<ul><li>a</li><li>b</li></ul>')
    expect(renderMarkdown('1. one\n2. two')).toBe('<ol><li>one</li><li>two</li></ol>')
    expect(renderMarkdown('* **Meteors:** burn up')).toBe('<ul><li><strong>Meteors:</strong> burn up</li></ul>')
  })
  it('inline code is not further formatted', () => {
    expect(renderMarkdown('use `a*b*c`')).toBe('<p>use <code>a*b*c</code></p>')
  })
  it('fenced code block, escaped', () => {
    expect(renderMarkdown('```js\nconst x = 1 < 2\n```')).toBe(
      '<pre class="dls-md-pre"><code>const x = 1 &lt; 2</code></pre>',
    )
  })
  it('paragraphs split on blank lines; soft breaks become <br>', () => {
    expect(renderMarkdown('a\nb\n\nc')).toBe('<p>a<br>b</p>\n<p>c</p>')
  })
  it('blockquote', () => {
    expect(renderMarkdown('> quoted')).toBe('<blockquote>quoted</blockquote>')
  })
  it('safe link', () => {
    expect(renderMarkdown('[Divinci](https://divinci.app)')).toBe(
      '<p><a href="https://divinci.app" target="_blank" rel="noopener noreferrer">Divinci</a></p>',
    )
  })
})

describe('renderMarkdown — XSS safety', () => {
  it('escapes raw HTML', () => {
    const out = renderMarkdown('<script>alert(1)</script>')
    expect(out).not.toContain('<script>')
    expect(out).toContain('&lt;script&gt;')
  })
  it('neutralizes an img onerror payload', () => {
    const out = renderMarkdown('<img src=x onerror=alert(1)>')
    expect(out).not.toMatch(/<img/i)
    expect(out).toContain('&lt;img')
  })
  it('blocks javascript: link hrefs', () => {
    const out = renderMarkdown('[click](javascript:alert(1))')
    expect(out).not.toContain('javascript:')
    expect(out).toContain('href="#"')
  })
  it('blocks data: link hrefs', () => {
    expect(renderMarkdown('[x](data:text/html,<script>1</script>)')).toContain('href="#"')
  })
  it('cannot break out of the href attribute', () => {
    const out = renderMarkdown('[x](https://a.com" onmouseover="alert(1))')
    // The quote is escaped, so the attribute can't be closed early.
    expect(out).not.toContain('onmouseover="alert')
  })
  it('does not emit unexpected tags from bold/quote payloads', () => {
    const out = renderMarkdown('**<b>x</b>**')
    expect(out).toBe('<p><strong>&lt;b&gt;x&lt;/b&gt;</strong></p>')
  })
})

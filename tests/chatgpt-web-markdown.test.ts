import { expect, test } from "bun:test";
import { chatGptHtmlToMarkdown } from "../src/adapters/chatgpt-web/markdown";

test("turns observed inline file path formats into Markdown links", () => {
  const cases = [
    {
      path: "output/path-format-probe/alpha-notes.md",
      target: "output/path-format-probe/alpha-notes.md",
    },
    {
      path: "output/path-format-probe/beta-report.json",
      target: "output/path-format-probe/beta-report.json",
    },
    {
      path: "/Users/example/codex-chatgpt-web/src/path-format-probe/gamma-helper.ts",
      target: "/Users/example/codex-chatgpt-web/src/path-format-probe/gamma-helper.ts",
    },
    {
      path: "/Users/example/codex-chatgpt-web/output/path-format-probe/epsilon-report.pdf",
      target: "/Users/example/codex-chatgpt-web/output/path-format-probe/epsilon-report.pdf",
    },
    {
      path: String.raw`C:\Users\Dev\Documents\Codex\path-format-probe\zeta-result.pdf`,
      target: "C:/Users/Dev/Documents/Codex/path-format-probe/zeta-result.pdf",
    },
    {
      path: String.raw`C:\Codex_Project_Unity\_Editor\file.cs`,
      target: "C:/Codex_Project_Unity/_Editor/file.cs",
    },
    {
      path: String.raw`C:\Codex_Project_Unity\_file.cs`,
      target: "C:/Codex_Project_Unity/_file.cs",
    },
    {
      path: String.raw`\\server\share_name\_Editor\file.cs`,
      target: "//server/share_name/_Editor/file.cs",
    },
    {
      path: "src/_private_/file_name.ts",
      target: "src/_private_/file_name.ts",
    },
    {
      path: "src/adapters/chatgpt-web/markdown.ts:47:3",
      target: "src/adapters/chatgpt-web/markdown.ts:47:3",
    },
  ];

  for (const { path, target } of cases) {
    const markdown = chatGptHtmlToMarkdown(`<p>Created <code>${path}</code>.</p>`);
    expect(markdown).toContain(`](<${target}>)`);
    expect(Bun.markdown.html(markdown))
      .toBe(`<p>Created <a href="${target}">${path}</a>.</p>\n`);
  }
});

test("preserves inline code that is not an unambiguous file path", () => {
  const html = [
    "<p>",
    "Run <code>bun test tests/example.test.ts</code>, inspect <code>FileChangeItem</code>, ",
    "and retain <code>turn/diff/updated</code>, <code>https://example.com/report.pdf</code>, ",
    "and <code>src/path without-extension</code>, <code>src/.</code>, and <code>src/..</code>.",
    "</p>",
    "<pre><code>src/example.ts</code></pre>",
  ].join("");

  expect(chatGptHtmlToMarkdown(html)).toBe([
    "Run `bun test tests/example.test.ts`, inspect `FileChangeItem`, and retain `turn/diff/updated`, `https://example.com/report.pdf`, and `src/path without-extension`, `src/.`, and `src/..`.",
    "",
    "```",
    "src/example.ts",
    "```",
  ].join("\n"));
});

test("does not nest a generated file link inside an existing link", () => {
  expect(chatGptHtmlToMarkdown(
    '<p>Open <a href="https://example.com/source"><code>src/example.ts</code></a>.</p>',
  )).toBe("Open [`src/example.ts`](https://example.com/source).");
});

test("preserves modern ChatGPT plain-text panes as fenced code, including Windows paths and blank lines", () => {
  const first = String.raw`C:\Program Files\SVP 4\mpv64\python.exe`;
  const second = String.raw`C:\Users\marcm\AppData\Local\Python\pythoncore-3.13-64\python.exe`;
  const source = `${first}\nPython 3.12.9\n\n${second}\nPython 3.13.14`;
  const html = [
    "<p>I verified both executables locally:</p>",
    '<div class="CodeBlock"><div data-markdown-copy="code-block">',
    '<div class="StickyActionBar"><svg></svg><div>Plain text</div><button>Copy</button></div>',
    `<div class="chatgpt-code-scrollport"><code class="whitespace-pre block"><span>${source}</span></code></div>`,
    "</div></div>",
  ].join("");

  expect(chatGptHtmlToMarkdown(html)).toBe([
    "I verified both executables locally:",
    "",
    "```",
    source,
    "```",
  ].join("\n"));
});

test("keeps a one-line code-pane directory as code and retains a PowerShell pane's language", () => {
  const directory = String.raw`C:\Users\marcm\AppData\Local\Python\pythoncore-3.13-64`;
  const plain = `<div data-markdown-copy="code-block"><div><div>Plain text</div></div><div><code>${directory}</code></div></div>`;
  const powershell = '<div data-markdown-copy="code-block"><div><div>powershell</div></div><div><pre><code>python --version</code></pre></div></div>';

  expect(chatGptHtmlToMarkdown(`${plain}${powershell}`)).toBe([
    "```",
    directory,
    "```",
    "",
    "```powershell",
    "python --version",
    "```",
  ].join("\n"));
});

test("modern code panes lengthen fences around backticks in their source", () => {
  const html = '<div data-markdown-copy="code-block"><div><div>Plain text</div></div><div><code>```not a fence\nnext line</code></div></div>';
  expect(chatGptHtmlToMarkdown(html)).toBe("````\n```not a fence\nnext line\n````");
});

test("converts Obsidian aliases and headings but preserves code examples and embeds", () => {
  const html = [
    "<p>Open [[Notes/weekly-review|review]] and [[Projects/sample#Status]].</p>",
    "<p>Keep <code>[[wiki/example]]</code> and ![[image.png]] literal.</p>",
    "<pre><code>\`\`\`not a closing fence\n[[wiki/fenced]]</code></pre>",
  ].join("");

  expect(chatGptHtmlToMarkdown(html)).toBe([
    "Open [review](<Notes/weekly-review.md>) and [Projects/sample#Status](<Projects/sample.md#Status>).",
    "",
    "Keep `[[wiki/example]]` and ![[image.png]] literal.",
    "",
    "````",
    "```not a closing fence",
    "[[wiki/fenced]]",
    "````",
  ].join("\n"));
});

test("preserves standalone Codex plan markers in paragraphs and list continuations", () => {
  expect(chatGptHtmlToMarkdown([
    "<p>&lt;proposed_plan&gt;</p>",
    "<h2>Plan</h2>",
    "<ul><li><p>Keep snake_case.</p><p>&lt;/proposed_plan&gt;</p></li></ul>",
  ].join(""))).toBe([
    "<proposed_plan>", "", "## Plan", "", "- Keep snake\\_case.", "  ", "  </proposed_plan>",
  ].join("\n"));
  expect(chatGptHtmlToMarkdown("<p>&lt;proposed_plan&gt;<br>Step<br>&lt;/proposed_plan&gt;</p>"))
    .toBe("<proposed_plan>  \nStep  \n</proposed_plan>");
});

test("preserving plan markers does not rewrite mentions or literal code", () => {
  expect(chatGptHtmlToMarkdown([
    "<p>Mention &lt;proposed_plan&gt; and &lt;/proposed_plan&gt; inline.</p>",
    "<p><code>&lt;proposed_plan&gt;</code> <code>&lt;/proposed_plan&gt;</code></p>",
    "<pre><code>&lt;proposed\\_plan&gt;\n&lt;/proposed\\_plan&gt;</code></pre>",
  ].join(""))).toBe([
    "Mention <proposed\\_plan> and </proposed\\_plan> inline.", "",
    "`<proposed_plan>` `</proposed_plan>`", "",
    "```", "<proposed\\_plan>", "</proposed\\_plan>", "```",
  ].join("\n"));
});

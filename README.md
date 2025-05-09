# open-notion

Notion と Markdown の双方向変換ユーティリティライブラリです。

## インストール

```bash
npm install open-notion
# または
yarn add open-notion
# または
pnpm add open-notion
```

## 使い方

### Notion から Markdown への変換

```typescript
import { fromNotionBlocks } from 'open-notion';
import { Client } from '@notionhq/client';

// Notion API クライアントの初期化
const notion = new Client({ auth: process.env.NOTION_TOKEN });

// Notion ページのブロックを取得
const response = await notion.blocks.children.list({
  block_id: 'ページID',
});

// Markdown に変換
const markdown = fromNotionBlocks(response.results);
console.log(markdown);
```

### Markdown から Notion ブロックへの変換

```typescript
import { toNotionBlocks } from 'open-notion';

const markdown = `# タイトル
これは段落です。

- リスト項目1
- リスト項目2
`;

// Notion ブロックに変換
const blocks = toNotionBlocks(markdown);
console.log(blocks);
```

## API

### `fromNotionBlock(block: NotionBlock): string`

単一の Notion ブロックを Markdown に変換します。

### `fromNotionBlocks(blocks: NotionBlock[]): string`

複数の Notion ブロックを Markdown に変換します。

### `toNotionBlocks(mdText: string): NotionBlock[]`

Markdown テキストを Notion ブロックの配列に変換します。

### `defineSchema`, `defineTable`

Notion データベースのスキーマを定義するためのユーティリティ関数です。

## ライセンス

MIT

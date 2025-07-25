import type { Client } from "@notionhq/client"
import { toNotionBlocks } from "../to-notion-block/to-notion-blocks"
import { NotionMarkdown } from "./notion-markdown"
import { NotionMemoryCache } from "./notion-memory-cache"
import { NotionConverter } from "./notion-property-converter"
import { NotionQueryBuilder } from "./notion-query-builder"
import { NotionSchemaValidator } from "./notion-schema-validator"
import type {
  BatchResult,
  FindOptions,
  NotionPage,
  QueryResult,
  Schema,
  SchemaType,
  SortOption,
  TableHooks,
  TableRecord,
  UpdateManyOptions,
  UpsertOptions,
  WhereCondition,
} from "./types"

export class NotionTable<T extends Schema> {
  private readonly client: Client
  private readonly tableId: string
  private readonly schema: T
  private readonly cache: NotionMemoryCache
  private readonly validator: NotionSchemaValidator
  private readonly queryBuilder: NotionQueryBuilder
  private readonly converter: NotionConverter
  private readonly enhancer: NotionMarkdown
  public hooks: TableHooks<T> = {}

  constructor(options: {
    client: Client
    tableId: string
    schema: T
    cache?: NotionMemoryCache
    validator?: NotionSchemaValidator
    queryBuilder?: NotionQueryBuilder
    converter?: NotionConverter
    enhancer?: NotionMarkdown
  }) {
    this.client = options.client
    this.tableId = options.tableId
    this.schema = options.schema
    this.cache = options.cache || new NotionMemoryCache()
    this.validator = options.validator || new NotionSchemaValidator()
    this.queryBuilder = options.queryBuilder || new NotionQueryBuilder()
    this.converter = options.converter || new NotionConverter()
    this.enhancer = options.enhancer || new NotionMarkdown()
  }

  /* 複数レコード取得（ページネーション・ソート機能付き） */
  async findMany(
    options: FindOptions<T> = {},
  ): Promise<QueryResult<SchemaType<T>>> {
    const { where = {}, count = 100, sorts } = options

    const maxCount = Math.min(Math.max(1, count), 1024)
    const pageSize = Math.min(maxCount, 100)

    const notionFilter =
      Object.keys(where).length > 0
        ? this.queryBuilder?.buildFilter(this.schema, where)
        : undefined

    const notionSort = this.buildNotionSort(sorts)

    const allRecords = await this.fetchAllRecords(
      maxCount,
      pageSize,
      notionFilter,
      notionSort,
    )

    return {
      records: allRecords.records,
      cursor: allRecords.cursor,
      hasMore: allRecords.hasMore,
    }
  }

  /* 指定した条件に一致する最初のレコードを取得 */
  async findOne(
    options: FindOptions<T> = {},
  ): Promise<TableRecord<SchemaType<T>> | null> {
    const result = await this.findMany({
      ...options,
      count: 1,
    })
    return result.records[0] || null
  }

  /* IDで1件取得（キャッシュ対応） */
  async findById(
    id: string,
    options?: { cache?: boolean },
  ): Promise<TableRecord<SchemaType<T>> | null> {
    const cacheKey = `page:${id}`

    if (options?.cache) {
      const cached = this.cache?.get<TableRecord<SchemaType<T>>>(cacheKey)
      if (cached) {
        return cached
      }
    }

    try {
      const response = await this.client.pages.retrieve({ page_id: id })
      const record = this.convertPageToRecord(response as unknown as NotionPage)

      if (options?.cache) {
        this.cache?.set(cacheKey, record)
      }

      return record
    } catch {
      return null
    }
  }

  /* レコード作成 */
  async create(
    data: Partial<SchemaType<T>> & { body?: string },
  ): Promise<TableRecord<SchemaType<T>>> {
    this.validator?.validate(this.schema, data)

    const processedData = this.hooks.beforeCreate
      ? await this.hooks.beforeCreate(data)
      : data

    if (!this.converter) {
      throw new Error("Converter is not initialized")
    }

    const properties = this.converter?.toNotion(this.schema, processedData)

    let children: unknown[] | undefined
    if (processedData.body) {
      const blocks = toNotionBlocks(processedData.body as string)
      children = blocks.map((block) => {
        if ("type" in block && typeof block.type === "string") {
          const enhancedType = this.enhancer.enhanceBlockType(block.type)
          return { ...block, type: enhancedType } as typeof block
        }
        return block
      })
    }

    const response = await this.client.pages.create({
      parent: { database_id: this.tableId },
      properties: properties as never,
      children: children as never,
    })

    const record = await this.findById(response.id)
    if (!record) {
      throw new Error("作成したレコードの取得に失敗しました")
    }

    if (this.hooks.afterCreate) {
      await this.hooks.afterCreate(record)
    }

    return record
  }

  /* 複数レコード作成（バッチ処理） */
  async createMany(
    records: Array<Partial<SchemaType<T>> & { body?: string }>,
  ): Promise<BatchResult<TableRecord<SchemaType<T>>>> {
    const results = await Promise.allSettled(
      records.map((record) => this.create(record)),
    )

    const succeeded: TableRecord<SchemaType<T>>[] = []
    const failed: Array<{
      data: Partial<SchemaType<T>> & { body?: string }
      error: Error
    }> = []

    for (const [index, result] of results.entries()) {
      if (result.status === "fulfilled") {
        succeeded.push(result.value)
        continue
      }

      const record = records[index]
      if (record) {
        failed.push({
          data: record,
          error:
            result.reason instanceof Error
              ? result.reason
              : new Error(String(result.reason)),
        })
      }
    }

    return { succeeded, failed }
  }

  /* レコード更新 */
  async update(
    id: string,
    data: Partial<SchemaType<T>> & { body?: string | null },
  ): Promise<void> {
    const dataForValidation = this.prepareDataForValidation(data)
    this.validator?.validate(this.schema, dataForValidation)

    const processedData = this.hooks.beforeUpdate
      ? await this.hooks.beforeUpdate(id, data)
      : data

    if (!this.converter) {
      throw new Error("Converter is not initialized")
    }

    const properties = this.converter.toNotion(this.schema, processedData)

    await this.client.pages.update({
      page_id: id,
      properties: properties as never,
    })

    if (processedData.body) {
      await this.updatePageContent(id, processedData.body as string)
    }

    this.cache?.delete(`page:${id}`)

    if (this.hooks.afterUpdate) {
      const record = await this.findById(id)
      if (record) {
        await this.hooks.afterUpdate(id, record)
      }
    }
  }

  /* 条件に一致する複数レコードを更新 */
  async updateMany(options: UpdateManyOptions<T>): Promise<number> {
    const { where = {}, update, count = 1024 } = options

    const result = await this.findMany({ where, count })

    let updated = 0
    for (const record of result.records) {
      await this.update(record.id, update)
      updated++
    }

    return updated
  }

  /* upsert処理（既存レコードがあれば更新、なければ作成） */
  async upsert(options: UpsertOptions<T>): Promise<TableRecord<SchemaType<T>>> {
    const { where, insert = {}, update } = options

    const existingRecord = await this.findOne({ where })

    if (existingRecord) {
      await this.update(existingRecord.id, update)
      const updated = await this.findById(existingRecord.id)
      return updated as TableRecord<SchemaType<T>>
    }

    const createData = { ...where, ...insert } as Partial<SchemaType<T>>
    return await this.create(createData)
  }

  /* 条件に一致する複数レコードを削除（アーカイブ） */
  async deleteMany(where: WhereCondition<T> = {}): Promise<number> {
    const result = await this.findMany({ where, count: 1024 })

    let deleted = 0
    for (const record of result.records) {
      await this.delete(record.id)
      deleted++
    }

    return deleted
  }

  /* レコード削除（アーカイブ） */
  async delete(id: string): Promise<void> {
    if (this.hooks.beforeDelete) {
      await this.hooks.beforeDelete(id)
    }

    await this.client.pages.update({
      page_id: id,
      archived: true,
    })

    this.cache?.delete(`page:${id}`)

    if (this.hooks.afterDelete) {
      await this.hooks.afterDelete(id)
    }
  }

  /* レコード復元 */
  async restore(id: string): Promise<void> {
    await this.client.pages.update({
      page_id: id,
      archived: false,
    })

    this.cache?.delete(`page:${id}`)
  }

  /* キャッシュクリア */
  clearCache(): void {
    this.cache?.clear()
  }

  /* プライベートメソッド */
  private buildNotionSort(
    sorts: SortOption<T> | SortOption<T>[] | undefined,
  ): Array<Record<string, unknown>> {
    if (!sorts) {
      return []
    }
    const sortArray = Array.isArray(sorts) ? sorts : [sorts]
    return this.queryBuilder?.buildSort(sortArray) || []
  }

  private async fetchAllRecords(
    maxCount: number,
    pageSize: number,
    notionFilter: Record<string, unknown> | undefined,
    notionSort: Array<Record<string, unknown>>,
  ): Promise<{
    records: TableRecord<SchemaType<T>>[]
    cursor: string | null
    hasMore: boolean
  }> {
    const allRecords: TableRecord<SchemaType<T>>[] = []
    let nextCursor: string | null = null
    let hasMore = true

    while (hasMore && allRecords.length < maxCount) {
      const response = await this.client.databases.query({
        database_id: this.tableId,
        filter: notionFilter as never,
        sorts: notionSort.length > 0 ? (notionSort as never) : undefined,
        start_cursor: nextCursor || undefined,
        page_size: pageSize,
      })

      const pageRecords = response.results.map((page) =>
        this.convertPageToRecord(page as unknown as NotionPage),
      )

      allRecords.push(...pageRecords)
      nextCursor = response.next_cursor
      hasMore = response.has_more && allRecords.length < maxCount
    }

    if (allRecords.length > maxCount) {
      return {
        records: allRecords.slice(0, maxCount),
        cursor: nextCursor,
        hasMore,
      }
    }

    return {
      records: allRecords,
      cursor: nextCursor,
      hasMore,
    }
  }

  private convertPageToRecord(page: NotionPage): TableRecord<SchemaType<T>> {
    if (!this.converter) {
      throw new Error("Converter is not initialized")
    }
    const data = this.converter.fromNotion(this.schema, page.properties)
    return {
      id: page.id,
      createdAt: page.created_time,
      updatedAt: page.last_edited_time,
      isDeleted: page.archived,
      ...data,
    } as TableRecord<SchemaType<T>>
  }

  private prepareDataForValidation(
    data: Partial<SchemaType<T>>,
  ): Partial<SchemaType<T>> {
    const dataWithoutRequired = { ...data }
    for (const [key, config] of Object.entries(this.schema)) {
      if (config.required && dataWithoutRequired[key] === undefined) {
        delete dataWithoutRequired[key]
      }
    }
    return dataWithoutRequired
  }

  private async updatePageContent(id: string, content: string): Promise<void> {
    const blocksResult = await this.client.blocks.children.list({
      block_id: id,
    })

    for (const block of blocksResult.results) {
      await this.client.blocks.delete({
        block_id: block.id,
      })
    }

    const blocks = toNotionBlocks(content)
    const enhancedBlocks = blocks.map((block) => {
      if ("type" in block && typeof block.type === "string") {
        const enhancedType = this.enhancer.enhanceBlockType(block.type)
        return { ...block, type: enhancedType } as typeof block
      }
      return block
    })

    await this.client.blocks.children.append({
      block_id: id,
      children: enhancedBlocks as never,
    })
  }
}

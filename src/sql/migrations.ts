import { TraceDOQueries, PartitionDOQueries } from "./queries"; export function runPartitionDOMigrations(sql: SqlStorage) {
    sql.exec(PartitionDOQueries.Schema.CREATE_ITEMS);
}

export function runTraceDOMigrations(sql: SqlStorage) {
    sql.exec(TraceDOQueries.Schema.CREATE_EVENTS);
}

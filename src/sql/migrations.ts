import { SubDOQueries, TraceDOQueries, PartitionDOQueries } from "./queries";

export function runSubDOMigrations(sql: SqlStorage) {
    sql.exec(SubDOQueries.Schema.CREATE_METADATA);
    sql.exec(SubDOQueries.Schema.CREATE_ITEMS);
    sql.exec(SubDOQueries.Schema.CREATE_CURSORS);
}

export function runPartitionDOMigrations(sql: SqlStorage) {
    sql.exec(PartitionDOQueries.Schema.CREATE_REPLICAS);
}

export function runTraceDOMigrations(sql: SqlStorage) {
    sql.exec(TraceDOQueries.Schema.CREATE_EVENTS);
}

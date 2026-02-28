/** Single trace event for request observability */
export interface TraceEvent {
	requestId: string;
	traceId?: string;
	step: string;
	startMs: number;
	durationMs: number;
	parent?: string;
	attributes?: Record<string, string | number | boolean>;
}

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenApiSpec {
    pub openapi: String,
    pub info: ApiInfo,
    pub servers: Vec<ApiServer>,
    pub paths: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiInfo {
    pub title: String,
    pub version: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiServer {
    pub url: String,
    pub description: String,
}

impl Default for OpenApiSpec {
    fn default() -> Self {
        Self {
            openapi: "3.0.0".to_string(),
            info: ApiInfo {
                title: "PrintNinja API".to_string(),
                version: env!("CARGO_PKG_VERSION").to_string(),
                description: "Local REST API for PrintNinja print automation".to_string(),
            },
            servers: vec![ApiServer {
                url: "http://127.0.0.1:17717".to_string(),
                description: "Local server".to_string(),
            }],
            paths: serde_json::json!({
                "/v1/health": {
                    "get": {
                        "summary": "Health check",
                        "description": "Unauthenticated liveness probe.",
                        "responses": {
                            "200": { "description": "Server is up" }
                        }
                    }
                },
                "/v1/printers": {
                    "get": {
                        "summary": "List printers",
                        "responses": {
                            "200": { "description": "Printers, with a `count`" },
                            "401": { "description": "Missing or invalid API key" },
                            "403": { "description": "Key lacks the required scope (GET needs `read`, every other method `print`), or its IP allowlist refused the caller" }
                        }
                    }
                },
                "/v1/templates": {
                    "get": {
                        "summary": "List templates",
                        "responses": {
                            "200": { "description": "Templates, with a `count`" },
                            "401": { "description": "Missing or invalid API key" },
                            "403": { "description": "Key lacks the required scope (GET needs `read`, every other method `print`), or its IP allowlist refused the caller" }
                        }
                    }
                },
                "/v1/metrics": {
                    "get": {
                        "summary": "Operational counters",
                        "description": "Jobs by status, active batches, queue-tracked printers, and completed totals since boot. Same shape every call; poll it.",
                        "responses": {
                            "200": { "description": "Counters" },
                            "401": { "description": "Missing or invalid API key" },
                            "403": { "description": "Key lacks the required scope (GET needs `read`, every other method `print`), or its IP allowlist refused the caller" }
                        }
                    }
                },
                "/v1/metrics/prometheus": {
                    "get": {
                        "summary": "Prometheus exposition",
                        "description": "Same counters as /v1/metrics in text format 0.0.4.",
                        "responses": {
                            "200": { "description": "Metrics in Prometheus text format" },
                            "401": { "description": "Missing or invalid API key" },
                            "403": { "description": "Key lacks the required scope (GET needs `read`, every other method `print`), or its IP allowlist refused the caller" }
                        }
                    }
                },
                "/v1/print": {
                    "post": {
                        "summary": "Render a template and print it",
                        "description": "## Renders, then prints.\n\n`template` is required — the API has no inline HTML body, so there is\nnothing to render without one. `data` is optional. The response reports\nthe real outcome:\n\n* `200` — printed, with the job id and duration.\n* `400` — missing `template`, or a `callback_url` was sent (callbacks are not implemented; poll `GET /v1/jobs/{id}` for the outcome).\n* `404` — printer or template not found, or the template has no current version.\n* `500` — the transport failed (printer offline, unsupported platform, …).\n\nSend `Idempotency-Key` on a retryable request. A replayed key returns\n`200` without printing a second copy.\n\nThis runs the same pipeline as the desktop UI and serialises on the\ntarget printer, so an API job and a UI job cannot interleave on one head.",
                        "parameters": [
                            { "name": "Authorization", "in": "header", "required": true,
                              "schema": { "type": "string" },
                              "description": "`Bearer <api-key>`" },
                            { "name": "Idempotency-Key", "in": "header", "required": false,
                              "schema": { "type": "string" },
                              "description": "Optional de-duplication key." }
                        ],
                        "requestBody": {
                            "required": true,
                            "content": {
                                "application/json": {
                                    "schema": {
                                        "type": "object",
                                        "required": ["template", "printer"],
                                        "properties": {
                                            "template": { "type": "string", "description": "Template name (case-insensitive)" },
                                            "printer": { "type": "string", "description": "Printer name (case-insensitive)" },
                                            "data": { "type": "object", "description": "Context merged into the template; optional — an empty context prints, like the preview" },
                                            "data_url": { "type": "string", "description": "Fetch this URL and use the JSON as `data` instead; `http`/`https` only, public addresses only" },
                                            "test": { "type": "boolean", "default": false },
                                            "settings": {
                                                "type": "object",
                                                "properties": {
                                                    "copies": { "type": "integer", "minimum": 1, "default": 1 },
                                                    "orientation": { "type": "string", "enum": ["portrait", "landscape"] },
                                                    "page_range": { "type": "string", "description": "1-based pages, e.g. \"1-3\" or \"1,3,5-7\"; empty means all" },
                                                    "grayscale": { "type": "boolean", "default": false },
                                                    "fit": { "type": "string", "enum": ["fit-width", "fit-page", "shrink", "fill"] }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        },
                        "responses": {
                            "200": { "description": "Printed: `{ job_id, status, duration_ms }`; also the `duplicate` body for a replayed `Idempotency-Key`" },
                            "400": { "description": "`template` is required, or `callback_url` was sent (not supported)" },
                            "401": { "description": "Missing or invalid API key" },
                            "403": { "description": "Key lacks the required scope (GET needs `read`, every other method `print`), or its IP allowlist refused the caller" },
                            "404": { "description": "Printer, template, or current version not found" },
                            "415": { "description": "Wrong or missing `Content-Type`" },
                            "422": { "description": "Malformed JSON, or `printer` missing" },
                            "500": { "description": "The transport failed" }
                        }
                    }
                },
                "/v1/jobs": {
                    "get": {
                        "summary": "List jobs",
                        "responses": {
                            "200": { "description": "Jobs, with a `count`" },
                            "401": { "description": "Missing or invalid API key" },
                            "403": { "description": "Key lacks the required scope (GET needs `read`, every other method `print`), or its IP allowlist refused the caller" }
                        }
                    }
                },
                "/v1/jobs/{id}": {
                    "get": {
                        "summary": "Get job status",
                        "responses": {
                            "200": { "description": "Job record" },
                            "400": { "description": "`id` is not an integer" },
                            "401": { "description": "Missing or invalid API key" },
                            "403": { "description": "Key lacks the required scope (GET needs `read`, every other method `print`), or its IP allowlist refused the caller" },
                            "404": { "description": "No such job" }
                        }
                    },
                    "delete": {
                        "summary": "Cancel a queued job",
                        "description": "Only a `queued` job can be cancelled; the row ends `cancelled`.",
                        "responses": {
                            "204": { "description": "Cancelled (no body)" },
                            "400": { "description": "`id` is not an integer, or the job is missing or not cancellable (already started or finished)" },
                            "401": { "description": "Missing or invalid API key" },
                            "403": { "description": "Key lacks the required scope (GET needs `read`, every other method `print`), or its IP allowlist refused the caller" }
                        }
                    }
                },
                "/v1/jobs/{id}/retry": {
                    "post": {
                        "summary": "Re-queue a failed or cancelled job",
                        "description": "Only a terminal row (`failed`, `cancelled`) is re-queued — a running or queued row is refused, so the worker can never print twice. The worker prints the re-queued row.",
                        "responses": {
                            "200": { "description": "Re-queued: `{ job_id, status }`" },
                            "400": { "description": "`id` is not an integer, or the job is not failed/cancelled" },
                            "401": { "description": "Missing or invalid API key" },
                            "403": { "description": "Key lacks the required scope (GET needs `read`, every other method `print`), or its IP allowlist refused the caller" },
                            "404": { "description": "No such job" }
                        }
                    }
                },
                "/v1/openapi.json": {
                    "get": {
                        "summary": "This document",
                        "responses": {
                            "200": { "description": "The OpenAPI description of this API" },
                            "401": { "description": "Missing or invalid API key" },
                            "403": { "description": "Key lacks the required scope (GET needs `read`, every other method `print`), or its IP allowlist refused the caller" }
                        }
                    }
                }
            }),
        }
    }
}

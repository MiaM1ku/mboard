# mboard API contract — v1

Independent implementation. Bun HTTP + SQLite; browser UI uses relative same-origin URLs. All `/api` replies use `{data: value}`; errors `{error: {code, message}}`, appropriate HTTP status. `/s/:token` is a content download and returns a raw sing-box JSON configuration (no data envelope). Field names snake_case. All byte counters are integer bytes. Times are ISO 8601 UTC strings or null. No Xboard runtime dependencies. A migration tool reads an offline JSON export.

## Host-separated subscription origin
Set `MBOARD_PUBLIC_ORIGIN` to the panel origin and `MBOARD_SUBSCRIPTION_ORIGIN` to a distinct subscription origin. The same HTTP listener classifies the actual `Host` header (URL authority fallback when absent). Exact normalized panel/loopback hostnames serve the app; the subscription hostname serves `GET` and `HEAD /s/:64hex-token`. Other routes/methods and unknown hostnames return 404. Domain selection ignores forwarded-host headers. Without a subscription origin the previous single-origin behavior remains available.

Owner User views include `subscription_url` when an origin is configured. That URL comes from trusted subscription/panel configuration, not request Host. Admin user lists redact token and URL. Subscription responses use `Content-Disposition: attachment; filename="mboard.json"`. Panel-domain subscription paths keep supporting existing links. The reverse proxy passes the original Host to the existing port.

## Public site
- `GET /api/v1/site` -> `{site_name:string,site_description:string}`; no session required, no private settings.

## Auth
- `POST /api/v1/auth/setup` `{email,password,name}` creates first admin once; password at least 12 chars. Returns User and session cookie. Atomic one-admin setup.
- `GET /api/v1/auth/status` -> `{setup_required:boolean,user:User|null}`.
- `POST /api/v1/auth/login` `{email,password}` -> User + HttpOnly SameSite=Strict session cookie.
- `POST /api/v1/auth/logout` -> `{ok:true}`.
- `GET /api/v1/me` -> User.
- `PATCH /api/v1/me/password` `{current_password,new_password}` -> `{ok:true}`; revoke other sessions.
User = `{id:number,email,name,role:'admin'|'user',enabled:boolean,created_at,upload_bytes:number,download_bytes:number,quota_bytes:number,expires_at:string|null,subscription_token:string,subscription_url?:string}`. Auth/me returns own subscription token; admin list should redact token.

## User
- `GET /api/v1/overview` -> `{user:User,nodes:Node[],traffic:TrafficPoint[],notices:Notice[]}`. Node list matches enabled group grants.
- `GET /api/v1/nodes` -> Node[] (authorized only).
- `GET /api/v1/traffic?days=30` -> TrafficPoint[]. `TrafficPoint={date:'YYYY-MM-DD',upload_bytes,download_bytes}`.
- `GET /api/v1/notices` -> Notice[]; `{id,title,body,created_at}`.
- `GET /api/v1/guides` -> Guide[]; `{id,title,body,category,created_at}`. Plain text safe content.
- `GET /api/v1/tickets` -> Ticket[]; `{id,subject,status:'open'|'closed',user_id,user_name,created_at,messages:Message[]}`. Message=`{id,body,author_role,created_at}`.
- `POST /api/v1/tickets` `{subject,body}` -> Ticket.
- `POST /api/v1/tickets/:id/messages` `{body}` -> Ticket.
- `PATCH /api/v1/tickets/:id` `{status:'closed'}` -> Ticket.
- `POST /api/v1/me/subscription/rotate` -> `{subscription_token,subscription_url?:string}`.
- `GET /s/:token` -> sing-box client JSON config. `HEAD` applies the same authorization checks and sends the corresponding headers. Authorized enabled nodes only. Client config uses independently generated UUID credentials and includes selector + urltest + direct. Subscription supports protocol selected in node, real configured endpoint and TLS.

## Admin
- `GET /api/v1/admin/overview` -> `{users:number,enabled_users:number,nodes:number,online_nodes:number,machines:number,online_machines:number,upload_bytes:number,download_bytes:number,traffic:TrafficPoint[],recent_machines:Machine[]}`.
- `GET/POST /api/v1/admin/users` list/create. Create `{email,name,password,enabled,quota_bytes,expires_at,group_ids:number[]}`. PATCH `/users/:id` same editable fields, optional password. DELETE `/users/:id` deletes account with confirmation frontend and preserves last admin safety. List User includes `group_ids` and redacts subscription_token.
- `GET/POST /api/v1/admin/groups`, PATCH/DELETE `/groups/:id`; `{id,name}`.
- `GET/POST /api/v1/admin/nodes`, PATCH/DELETE `/nodes/:id`.
Node = `{id,name,host,port:number,protocol:'vless'|'trojan'|'shadowsocks',enabled:boolean,machine_id:number|null,group_ids:number[],tls:boolean,server_name:string,online:boolean,created_at}`. POST/PATCH these fields excluding derived online, id, created_at. A node port is unique within its machine. VLESS/Trojan TLS needs server certificate provisioning on node, documented.
- `GET/POST /api/v1/admin/machines`, PATCH/DELETE `/machines/:id`; Machine = `{id,name,host,enabled:boolean,last_seen_at:string|null,version:string|null,online:boolean,config_revision:number}`. POST `{name,host,enabled}` -> `{machine:Machine,token:string}` (one-time token). PATCH same fields. POST `/machines/:id/token` -> `{token}` (rotation).
- `GET/POST /api/v1/admin/notices`, PATCH/DELETE `/notices/:id` (`title,body`).
- `GET/POST /api/v1/admin/guides`, PATCH/DELETE `/guides/:id` (`title,body,category`).
- `GET /api/v1/admin/tickets`; admin can reply/close via same ticket endpoints.
- `GET/PATCH /api/v1/admin/settings` -> `{site_name:string,site_description:string}`.
- `GET /api/v1/admin/audit` -> `[{id,actor,action,target,created_at}]` (latest 100).

## Node protocol
Bearer machine token. Store hashed tokens server-side. Browser sessions are rejected on node routes. Node enabled state gates requests. Body limit 1 MiB. Monotonic machine configuration revision.
- `POST /api/node/v1/heartbeat` `{version:string,uptime_seconds:number,config_revision:number}` -> `{server_time:string,config_revision:number}`.
- `GET /api/node/v1/config` -> `{revision:number,config:object}` (full sing-box server JSON). Empty enabled inbound set is an explicit valid revision to apply. Users carry unique UUID, group authorization, quota/expiry, protocol password derived from own credential. Config uses per-inbound user names equal to decimal user IDs. TLS file placeholders `/etc/mboard-node/tls/<node_id>.crt` and `.key`. Shadowsocks method `aes-128-gcm`.
- `POST /api/node/v1/traffic` `{batch_id:string,records:[{user_id:number,node_id:number,upload_bytes:number,download_bytes:number}]} -> {accepted:boolean}`. Unique machine_id+batch_id gives idempotence; validate ownership, user grant and safe integers. Same traffic may span multiple records. Atomic counter/ledger updates.

## Restored subscription templates
- `GET /api/v1/admin/subscription/templates` lists six independently stored formats and exact content, timestamps and source.
- `PUT /api/v1/admin/subscription/templates/:name` `{content}` validates and saves exact submitted bytes.
- `POST .../:name/validate` `{content}` returns `{valid,errors:[{message,line?,column?}],warnings}`.
- `POST .../:name/preview` `{content}` returns `{template_name,content_type,content,node_count,warnings}` using explicitly synthetic endpoints.
- Names: `singbox`, `clash`, `clashmeta`, `stash`, `surge`, `surfboard`. Maximum UTF-8 content is 512 KiB.
- Subscription `format`, `target` and legacy `flag` choose explicit formats. Otherwise actual client UA selects the format, including `clash.meta`.
- Original imported token links remain subscription-only compatibility paths until owner rotation. Administrative APIs keep their separate session/role gates.

## Restored machine runtime
Complete archived protocols, root/child entries and routing are normalized into independent runtime tables. Native `GET /api/node/v1/config` may include `traffic_labels:[{label,user_id,node_id}]` outside native config. Pending machines fetch config after verified credential provisioning; publication requires activation, the current applied numeric revision, ready core and ready telemetry, plus fresh heartbeat.

- Runtime heartbeat also accepts optional `core_ready` and `telemetry_ready` booleans.
- Runtime traffic uses a permanent per-machine batch ledger and separate entry-node daily attribution. Delayed valid-grant counters remain accountable after quota/expiry transitions.
- `POST /api/node/v1/enroll` `{machine_id}` exchanges exact archived credentials for new 64-hex credentials, or repairs an existing machine using its current bearer. Legacy source 32/64-character credentials apply to this one-time route. Configuration validation precedes issuance.
- `POST /api/node/v1/activate` `{config_revision}` uses current runtime bearer and fresh/current ready health, returning `{activated:true,machine_id,config_revision}`. Old source credential exchange closes after activation.
- Overview and node/machine lists merge restored runtime objects. Restored complex objects show their complete-config status, avoiding partial basic-editor overwrites.

## Safety
Origin check on mutation routes, cookie auth, secure cookies for HTTPS (development local HTTP supported). Rate-limit login. Prepared SQL. Validate enum/range/length. Admin role gates. New config revisions for user grant/credential/enable changes, nodes/groups changes, token rotations. Secrets excluded from audit/errors. SPA static path traversal protected. Demo fixtures only in browser test mocked responses.

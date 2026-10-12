# mboard API contract — v1

Independent implementation. Bun HTTP + SQLite; browser UI uses relative same-origin URLs. All `/api` replies use `{data: value}`; errors `{error: {code, message}}`, appropriate HTTP status. `/s/:token` is a content download and returns a raw sing-box JSON configuration (no data envelope). Field names snake_case. All byte counters are integer bytes. Times are ISO 8601 UTC strings or null. No Xboard runtime dependencies. A migration tool reads an offline JSON export.

## Public site
- `GET /api/v1/site` -> `{site_name:string,site_description:string}`; no session required, no private settings.

## Auth
- `POST /api/v1/auth/setup` `{email,password,name}` creates first admin once; password at least 12 chars. Returns User and session cookie. Atomic one-admin setup.
- `GET /api/v1/auth/status` -> `{setup_required:boolean,user:User|null}`.
- `POST /api/v1/auth/login` `{email,password}` -> User + HttpOnly SameSite=Strict session cookie.
- `POST /api/v1/auth/logout` -> `{ok:true}`.
- `GET /api/v1/me` -> User.
- `PATCH /api/v1/me/password` `{current_password,new_password}` -> `{ok:true}`; revoke other sessions.
User = `{id:number,email,name,role:'admin'|'user',enabled:boolean,created_at,upload_bytes:number,download_bytes:number,quota_bytes:number,expires_at:string|null,subscription_token:string}`. Auth/me returns own subscription token; admin list should redact token.

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
- `POST /api/v1/me/subscription/rotate` -> `{subscription_token}`.
- `GET /s/:token` -> sing-box client JSON config. Authorized enabled nodes only. Client config uses independently generated UUID credentials and includes selector + urltest + direct. Subscription supports protocol selected in node, real configured endpoint and TLS.

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

## Safety
Origin check on mutation routes, cookie auth, secure cookies for HTTPS (development local HTTP supported). Rate-limit login. Prepared SQL. Validate enum/range/length. Admin role gates. New config revisions for user grant/credential/enable changes, nodes/groups changes, token rotations. Secrets excluded from audit/errors. SPA static path traversal protected. Demo fixtures only in browser test mocked responses.

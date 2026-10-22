-- VAS OpenResty agent
--
-- Runs inside the nginx "privileged agent" process (same user as the master,
-- i.e. root) and periodically pulls the generated configuration bundle from
-- the VAS manager:
--
--   GET  $VAS_MANAGER_URL/api/agent/openresty/bundle?have=<rev>&failed=<rev>
--   POST $VAS_MANAGER_URL/api/agent/openresty/report
--
-- Each revision is written to $DATA/rev-<revision>/ and $DATA/live is an
-- atomically swapped symlink to the active revision (/etc/openresty/vas
-- points at $DATA/live). After `openresty -t` succeeds the master is sent
-- SIGHUP; on failure the previous revision is restored and the error is
-- reported back so it shows up in the web UI.

local cjson = require "cjson.safe"
local process = require "ngx.process"

local _M = { _VERSION = "0.1.0" }

local DATA = os.getenv("VAS_OPENRESTY_DATA") or "/data"
local MANAGER = (os.getenv("VAS_MANAGER_URL") or "http://127.0.0.1:8080"):gsub("/+$", "")
local TOKEN = os.getenv("VAS_AGENT_TOKEN") or ""
local INTERVAL = tonumber(os.getenv("VAS_POLL_INTERVAL") or "5") or 5
-- absolute path: the agent's environment comes from nginx and may not include PATH
local OPENRESTY = os.getenv("VAS_OPENRESTY_BIN") or "/usr/local/openresty/bin/openresty"
local HOSTNAME = os.getenv("HOSTNAME") or ""
-- Lua packages from the web UI are installed into this tree (on the /data volume,
-- so they survive container re-creation); nginx.conf has it in lua_package_path
local LUAROCKS = os.getenv("VAS_LUAROCKS_BIN") or "/usr/local/openresty/luajit/bin/luarocks"
local TREE = DATA .. "/luarocks"
local ROCKS_STATE = TREE .. "/.vas-state.json"
-- failed installs are retried this often (and on every new revision / "re-apply")
local ROCKS_RETRY = 300

local state = ngx.shared.vas_agent
-- polls yield on sockets, and a LuaRocks build can outlast the interval: never run two at once
local busy = false

local function q(s)
  return "'" .. (tostring(s):gsub("'", "'\\''")) .. "'"
end

local function run(cmd)
  local r1, _, r3 = os.execute(cmd)
  if type(r1) == "number" then
    return r1 == 0
  end
  return r1 == true and (r3 == nil or r3 == 0)
end

local function read_file(p)
  local f = io.open(p, "rb")
  if not f then
    return nil
  end
  local d = f:read("*a")
  f:close()
  return d
end

local function write_file(p, data, mode)
  local f, err = io.open(p, "wb")
  if not f then
    return nil, err
  end
  f:write(data)
  f:close()
  if mode then
    run("chmod " .. mode .. " " .. q(p))
  end
  return true
end

local function current_revision()
  local f = io.popen("readlink " .. q(DATA .. "/live") .. " 2>/dev/null")
  if not f then
    return nil
  end
  local target = f:read("*l")
  f:close()
  return target and target:match("rev%-(%w+)$") or nil
end

local function point_live(rev)
  run("ln -sfn " .. q("rev-" .. rev) .. " " .. q(DATA .. "/live.new"))
  return os.rename(DATA .. "/live.new", DATA .. "/live")
end

local function valid_path(p)
  return type(p) == "string" and p:match("^[%w_%-%./]+$") ~= nil and not p:find("..", 1, true) and p:sub(1, 1) ~= "/"
end

-- Minimal HTTP client on ngx.socket.tcp (no lua-resty-http, so the image needs
-- nothing from opm). It speaks HTTP/1.0 with "Connection: close": the server
-- then answers without chunked encoding and closes the connection, so the
-- response is simply everything read until close. A host name in
-- VAS_MANAGER_URL needs a `resolver` in nginx; the default 127.0.0.1 doesn't.
local function parse_url(url)
  local scheme, rest = url:match("^(https?)://(.+)$")
  if not scheme then
    return nil, "unsupported URL " .. url
  end
  local hostport, path = rest:match("^([^/]+)(.*)$")
  local host, port = hostport:match("^%[(.+)%]:?(%d*)$") -- [::1]:8080
  if not host then
    host, port = hostport:match("^([^:]+):?(%d*)$")
  end
  return {
    scheme = scheme,
    host = host,
    port = tonumber(port) or (scheme == "https" and 443 or 80),
    path = path ~= "" and path or "/",
  }
end

local function request(method, url, headers, body, timeout)
  local u, err = parse_url(url)
  if not u then
    return nil, err
  end
  local sock = ngx.socket.tcp()
  sock:settimeout(timeout or 15000)
  local ok, cerr = sock:connect(u.host, u.port)
  if not ok then
    return nil, "connect " .. u.host .. ":" .. u.port .. ": " .. tostring(cerr)
  end
  if u.scheme == "https" then
    local _, serr = sock:sslhandshake(nil, u.host, false)
    if serr then
      sock:close()
      return nil, "tls: " .. tostring(serr)
    end
  end
  local lines = { method .. " " .. u.path .. " HTTP/1.0", "Host: " .. u.host, "Connection: close" }
  for k, v in pairs(headers or {}) do
    lines[#lines + 1] = k .. ": " .. v
  end
  if body then
    lines[#lines + 1] = "Content-Length: " .. #body
  end
  local _, werr = sock:send(table.concat(lines, "\r\n") .. "\r\n\r\n" .. (body or ""))
  if werr then
    sock:close()
    return nil, "send: " .. tostring(werr)
  end
  local data, rerr, partial = sock:receive("*a")
  sock:close()
  data = data or partial
  if not data or data == "" then
    return nil, "receive: " .. tostring(rerr or "empty response")
  end
  local status = tonumber(data:match("^HTTP/%d%.%d (%d%d%d)"))
  if not status then
    return nil, "malformed response"
  end
  local sep = data:find("\r\n\r\n", 1, true)
  return { status = status, body = sep and data:sub(sep + 4) or "" }
end

local function report(ok, rev, msg)
  local res, err = request(
    "POST",
    MANAGER .. "/api/agent/openresty/report",
    {
      ["Authorization"] = "Bearer " .. TOKEN,
      ["Content-Type"] = "application/json",
    },
    cjson.encode({
      ok = ok,
      revision = rev,
      message = msg or "",
      hostname = HOSTNAME,
      version = "openresty " .. tostring(ngx.config.nginx_version) .. " / ngx_lua " .. tostring(ngx.config.ngx_lua_version),
    }),
    10000
  )
  if not res then
    ngx.log(ngx.WARN, "vas agent: report failed: ", err)
  elseif res.status >= 300 then
    ngx.log(ngx.WARN, "vas agent: report rejected with HTTP ", res.status)
  end
end

local function prune(keep)
  local p = io.popen("ls -1 " .. q(DATA))
  if not p then
    return
  end
  for name in p:lines() do
    if name:match("^rev%-") and not keep[name] then
      run("rm -rf " .. q(DATA .. "/" .. name))
    end
  end
  p:close()
end

local function apply(bundle)
  local rev = bundle.revision
  if type(rev) ~= "string" or not rev:match("^%w+$") then
    return nil, "invalid revision"
  end
  local dir = DATA .. "/rev-" .. rev
  local tmp = dir .. ".tmp"
  run("rm -rf " .. q(tmp))
  for _, sub in ipairs({ "http", "stream", "lua", "certs" }) do
    run("mkdir -p " .. q(tmp .. "/" .. sub))
  end
  for path, content in pairs(bundle.files or {}) do
    if not valid_path(path) then
      return nil, "invalid path in bundle: " .. tostring(path)
    end
    local full = tmp .. "/" .. path
    run("mkdir -p " .. q(full:match("^(.*)/[^/]+$")))
    local ok, err = write_file(full, content, path:match("key%.pem$") and "600" or nil)
    if not ok then
      return nil, "write " .. path .. ": " .. tostring(err)
    end
  end
  run("rm -rf " .. q(dir))
  local ok, err = os.rename(tmp, dir)
  if not ok then
    return nil, err
  end

  local prev = current_revision()
  ok, err = point_live(rev)
  if not ok then
    return nil, err
  end

  local log = DATA .. "/test.log"
  if not run(OPENRESTY .. " -t > " .. q(log) .. " 2>&1") then
    local out = read_file(log) or ""
    if prev then
      point_live(prev)
    end
    run("rm -rf " .. q(dir))
    return nil, "config test failed, rolled back to " .. tostring(prev) .. ":\n" .. out
  end

  local keep = { ["rev-" .. rev] = true }
  if prev then
    keep["rev-" .. prev] = true
  end
  prune(keep)
  return true, read_file(log) or ""
end

-- ---- LuaRocks ---------------------------------------------------------------

local function valid_rock(name, version)
  return type(name) == "string" and #name <= 64 and name:match("^[%w][%w_%.%-]*$") ~= nil
    and (version == nil or version == "" or (type(version) == "string" and #version <= 32 and version:match("^[%w_%.%-]+$") ~= nil))
end

local function tail(s, n)
  s = s or ""
  return #s > n and ("..." .. s:sub(-n)) or s
end

local function rocks_cmd(args, server)
  -- HOME: luarocks keeps its cache there and nginx strips the environment
  local cmd = "HOME=" .. q(TREE .. "/.home") .. " " .. q(LUAROCKS) .. " --tree " .. q(TREE)
  if server and server ~= "" then
    cmd = cmd .. " --server " .. q(server)
  end
  return cmd .. " " .. args
end

-- name -> installed version, from `luarocks list --porcelain` (name, version, status, tree)
local function installed_rocks()
  local out = {}
  local p = io.popen(rocks_cmd("list --porcelain") .. " 2>/dev/null")
  if not p then
    return out
  end
  for line in p:lines() do
    local name, version = line:match("^([^\t]+)\t([^\t]+)")
    if name then
      out[name] = version
    end
  end
  p:close()
  return out
end

local function report_rocks(results)
  local list = {}
  for _, r in pairs(results) do
    list[#list + 1] = r
  end
  table.sort(list, function(a, b)
    return a.name < b.name
  end)
  local res, err = request(
    "POST",
    MANAGER .. "/api/agent/openresty/lua-packages",
    { ["Authorization"] = "Bearer " .. TOKEN, ["Content-Type"] = "application/json" },
    cjson.encode({ packages = list }),
    10000
  )
  if not res then
    ngx.log(ngx.WARN, "vas agent: LuaRocks report failed: ", err)
  end
end

-- Makes TREE match spec ({server, packages = {{name, version}}}). With force (a new
-- revision) it installs what is missing or changed, retries failures and removes
-- what is no longer wanted; without it (idle polls) it only retries failures that
-- are older than ROCKS_RETRY, so an idle agent doesn't run luarocks at all.
-- Returns true when the tree changed.
local function sync_rocks(spec, force)
  spec = type(spec) == "table" and spec or {}
  local server = type(spec.server) == "string" and spec.server:match("^https?://[^%s'\"`$\\;|&<>]+$") and spec.server or nil
  local st = cjson.decode(read_file(ROCKS_STATE) or "") or {}
  st.packages = type(st.packages) == "table" and st.packages or {}

  local wanted = {}
  for _, p in ipairs(type(spec.packages) == "table" and spec.packages or {}) do
    if type(p) == "table" and valid_rock(p.name, p.version) then
      wanted[p.name] = p.version or ""
    end
  end
  local now = ngx.time()
  local todo = {}
  for name, version in pairs(wanted) do
    local s = st.packages[name]
    if not s or (s.version or "") ~= version then
      if force then
        todo[name] = version
      end
    elseif not s.ok and (force or now - (tonumber(s.tried) or 0) >= ROCKS_RETRY) then
      todo[name] = version
    end
  end
  local stale = false
  if force then
    for name in pairs(st.packages) do
      if wanted[name] == nil then
        stale = true
      end
    end
  end
  if next(todo) == nil and not stale and not (force and next(wanted) ~= nil) then
    return false
  end

  run("mkdir -p " .. q(TREE .. "/.home"))
  local have_bin = run("test -x " .. q(LUAROCKS))
  local changed, dirty = false, false
  local present = have_bin and installed_rocks() or {}

  if force then
    for name in pairs(st.packages) do
      if wanted[name] == nil then
        if present[name] then
          -- fails when another installed rock depends on it; it then simply stays
          run(rocks_cmd("remove " .. q(name)) .. " >/dev/null 2>&1")
          changed = true
          ngx.log(ngx.NOTICE, "vas agent: removed Lua package ", name)
        end
        st.packages[name] = nil
        dirty = true
      end
    end
    -- reinstall what vanished from the tree (e.g. /data/luarocks deleted by hand)
    for name, version in pairs(wanted) do
      local s = st.packages[name]
      if s and s.ok and not present[name] then
        todo[name] = version
      end
    end
  end

  for name, version in pairs(todo) do
    do
      local r = { name = name, version = version ~= "" and version or nil, tried = now, at = ngx.utctime() }
      if not have_bin then
        r.ok = false
        r.message = "luarocks not found at " .. LUAROCKS .. " (rebuild the OpenResty image from containers/openresty, or set VAS_LUAROCKS_BIN)"
      else
        ngx.log(ngx.NOTICE, "vas agent: installing Lua package ", name, version ~= "" and (" " .. version) or "")
        local log = TREE .. "/.install.log"
        local args = "install " .. q(name) .. (version ~= "" and (" " .. q(version)) or "")
        r.ok = run(rocks_cmd(args, server) .. " > " .. q(log) .. " 2>&1")
        r.message = tail(read_file(log), 3000)
        if r.ok then
          changed = true
        else
          ngx.log(ngx.ERR, "vas agent: cannot install Lua package ", name, ":\n", r.message)
        end
      end
      st.packages[name] = r
      dirty = true
    end
  end

  if dirty or changed then
    present = have_bin and installed_rocks() or {}
    for name, s in pairs(st.packages) do
      s.installed = present[name]
    end
    write_file(ROCKS_STATE, cjson.encode(st))
    local results = {}
    for name, s in pairs(st.packages) do
      results[name] = { name = name, version = s.version, installed = s.installed, ok = s.ok and true or false, message = s.message, at = s.at }
    end
    report_rocks(results)
  end
  return changed
end

local function rocks_spec(files)
  local raw = files and files["luarocks/packages.json"] or read_file(DATA .. "/live/luarocks/packages.json")
  return raw and cjson.decode(raw) or nil
end

local function poll_once()
  local have = current_revision() or ""
  local failed = state and state:get("failed") or ""
  local res, err = request(
    "GET",
    MANAGER .. "/api/agent/openresty/bundle?have=" .. ngx.escape_uri(have) .. "&failed=" .. ngx.escape_uri(failed),
    { ["Authorization"] = "Bearer " .. TOKEN },
    nil,
    15000
  )
  if not res then
    ngx.log(ngx.WARN, "vas agent: cannot reach manager at ", MANAGER, ": ", err)
    return
  end
  if res.status == 204 then
    -- nothing new: only retry failed package installs; a fresh install needs a
    -- reload so modules required at init time are picked up
    if sync_rocks(rocks_spec(nil), false) then
      run("kill -HUP " .. tostring(process.get_master_pid()))
    end
    return
  end
  if res.status ~= 200 then
    ngx.log(ngx.ERR, "vas agent: manager returned HTTP ", res.status, " (check VAS_AGENT_TOKEN)")
    return
  end
  local bundle = cjson.decode(res.body)
  if type(bundle) ~= "table" or bundle.revision == have then
    return
  end

  -- packages first, so the new config's Lua finds them; a failed install is
  -- reported but doesn't block the config (only the code that requires it breaks)
  local rok, rerr = pcall(sync_rocks, rocks_spec(bundle.files), true)
  if not rok then
    ngx.log(ngx.ERR, "vas agent: LuaRocks sync failed: ", rerr)
  end

  local ok, msg = apply(bundle)
  report(ok and true or false, bundle.revision, msg)
  if ok then
    if state then
      state:delete("failed")
    end
    ngx.log(ngx.NOTICE, "vas agent: applied revision ", bundle.revision, ", reloading")
    run("kill -HUP " .. tostring(process.get_master_pid()))
  else
    if state then
      state:set("failed", bundle.revision)
    end
    ngx.log(ngx.ERR, "vas agent: ", msg)
  end
end

local function poll(premature)
  if premature or busy then
    return
  end
  busy = true
  local ok, err = pcall(poll_once)
  busy = false
  if not ok then
    ngx.log(ngx.ERR, "vas agent: poll failed: ", err)
  end
end

function _M.init_worker()
  if process.type() ~= "privileged agent" then
    return
  end
  if TOKEN == "" then
    ngx.log(ngx.ERR, "vas agent: VAS_AGENT_TOKEN is not set, agent disabled")
    return
  end
  ngx.timer.at(0, poll)
  local ok, err = ngx.timer.every(INTERVAL, poll)
  if not ok then
    ngx.log(ngx.ERR, "vas agent: cannot start timer: ", err)
  end
end

return _M

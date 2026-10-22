-- Hastur OpenResty agent
--
-- Runs inside the nginx "privileged agent" process (same user as the master,
-- i.e. root) and periodically pulls the generated configuration bundle from
-- the Hastur manager:
--
--   GET  $HASTUR_MANAGER_URL/api/agent/openresty/bundle?have=<rev>&failed=<rev>
--   POST $HASTUR_MANAGER_URL/api/agent/openresty/report
--
-- Each revision is written to $DATA/rev-<revision>/ and $DATA/live is an
-- atomically swapped symlink to the active revision (/etc/openresty/hastur
-- points at $DATA/live). After `openresty -t` succeeds the master is sent
-- SIGHUP; on failure the previous revision is restored and the error is
-- reported back so it shows up in the web UI.

local cjson = require "cjson.safe"
local http = require "resty.http"
local process = require "ngx.process"

local _M = { _VERSION = "0.1.0" }

local DATA = os.getenv("HASTUR_OPENRESTY_DATA") or "/data"
local MANAGER = (os.getenv("HASTUR_MANAGER_URL") or "http://127.0.0.1:8080"):gsub("/+$", "")
local TOKEN = os.getenv("HASTUR_AGENT_TOKEN") or ""
local INTERVAL = tonumber(os.getenv("HASTUR_POLL_INTERVAL") or "5") or 5
-- absolute path: the agent's environment comes from nginx and may not include PATH
local OPENRESTY = os.getenv("HASTUR_OPENRESTY_BIN") or "/usr/local/openresty/bin/openresty"
local HOSTNAME = os.getenv("HOSTNAME") or ""

local state = ngx.shared.hastur_agent

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

local function report(ok, rev, msg)
  local httpc = http.new()
  httpc:set_timeout(10000)
  local res, err = httpc:request_uri(MANAGER .. "/api/agent/openresty/report", {
    method = "POST",
    headers = {
      ["Authorization"] = "Bearer " .. TOKEN,
      ["Content-Type"] = "application/json",
    },
    body = cjson.encode({
      ok = ok,
      revision = rev,
      message = msg or "",
      hostname = HOSTNAME,
      version = "openresty " .. tostring(ngx.config.nginx_version) .. " / ngx_lua " .. tostring(ngx.config.ngx_lua_version),
    }),
  })
  if not res then
    ngx.log(ngx.WARN, "hastur agent: report failed: ", err)
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

local function poll(premature)
  if premature then
    return
  end
  local have = current_revision() or ""
  local failed = state and state:get("failed") or ""
  local httpc = http.new()
  httpc:set_timeout(15000)
  local res, err = httpc:request_uri(
    MANAGER .. "/api/agent/openresty/bundle?have=" .. ngx.escape_uri(have) .. "&failed=" .. ngx.escape_uri(failed),
    { headers = { ["Authorization"] = "Bearer " .. TOKEN } }
  )
  if not res then
    ngx.log(ngx.WARN, "hastur agent: cannot reach manager at ", MANAGER, ": ", err)
    return
  end
  if res.status == 204 then
    return
  end
  if res.status ~= 200 then
    ngx.log(ngx.ERR, "hastur agent: manager returned HTTP ", res.status, " (check HASTUR_AGENT_TOKEN)")
    return
  end
  local bundle = cjson.decode(res.body)
  if type(bundle) ~= "table" or bundle.revision == have then
    return
  end

  local ok, msg = apply(bundle)
  report(ok and true or false, bundle.revision, msg)
  if ok then
    if state then
      state:delete("failed")
    end
    ngx.log(ngx.NOTICE, "hastur agent: applied revision ", bundle.revision, ", reloading")
    run("kill -HUP " .. tostring(process.get_master_pid()))
  else
    if state then
      state:set("failed", bundle.revision)
    end
    ngx.log(ngx.ERR, "hastur agent: ", msg)
  end
end

function _M.init_worker()
  if process.type() ~= "privileged agent" then
    return
  end
  if TOKEN == "" then
    ngx.log(ngx.ERR, "hastur agent: HASTUR_AGENT_TOKEN is not set, agent disabled")
    return
  end
  ngx.timer.at(0, poll)
  local ok, err = ngx.timer.every(INTERVAL, poll)
  if not ok then
    ngx.log(ngx.ERR, "hastur agent: cannot start timer: ", err)
  end
end

return _M

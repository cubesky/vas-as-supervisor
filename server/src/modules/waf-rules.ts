/**
 * Built-in WAF rules, evaluated by the Lua engine in OpenResty
 * (waf-lua.ts). Modelled after the OWASP Core Rule Set: every match adds the
 * rule's severity to an anomaly score and the request is blocked (or logged in
 * detect mode) once the score reaches the threshold (default 5, so a single
 * critical rule is enough). Paranoia levels gate rules that are more likely to
 * hit legitimate traffic: level 1 is safe for most sites, 2 adds request-body
 * checks for XSS/SQLi/code and stricter protocol checks.
 *
 * Patterns are PCRE (ngx.re), written so they also compile as JavaScript
 * regular expressions; values are URL-decoded (twice) before matching.
 */

export type WafTarget = 'uri' | 'raw_uri' | 'args' | 'body' | 'cookies' | 'ua' | 'referer' | 'headers' | 'method';
export type WafGroup = 'protocol' | 'scanner' | 'files' | 'lfi' | 'rce' | 'sqli' | 'xss' | 'ssrf' | 'java';

export interface WafRule {
  id: number;
  group: WafGroup;
  paranoia: 1 | 2 | 3;
  /** anomaly score: 5 critical, 4 error, 3 warning, 2 notice */
  severity: 2 | 3 | 4 | 5;
  targets: WafTarget[];
  pattern: string;
  /** case-insensitive unless false */
  caseless?: boolean;
  msg: string;
}

const UNION_SELECT = String.raw`\bunion\b[\s\S]{0,100}?\bselect\b`;
const SQL_FUNCS = String.raw`(?:\b(?:sleep|benchmark|pg_sleep|load_file|extractvalue|updatexml)\s*\(|\bwaitfor\s+delay\s+['"]|\binformation_schema\b|\binto\s+(?:out|dump)file\b)`;
const SCRIPT_TAG = String.raw`<script[\s/>]`;
const EVENT_HANDLER = String.raw`<[a-z][^>]*?[\s/]on[a-z]{3,}\s*=`;
const TRAVERSAL = String.raw`(?:^|[\\/])\.\.(?:[\\/]|$)`;
const CMD_INJECTION = String.raw`(?:[;|` + '`' + String.raw`]|&&|\|\||\$\()\s*(?:cat|ls|id|whoami|uname|wget|curl|nc|ncat|bash|sh|zsh|python\d?|perl|php|ruby|chmod|chown|rm|ping|nslookup|powershell|cmd)\b`;
const PHP_CODE = String.raw`(?:<\?php|\b(?:eval|assert|system|passthru|shell_exec|proc_open|popen|pcntl_exec|base64_decode)\s*\()`;

export const WAF_RULES: WafRule[] = [
  // --- protocol
  { id: 920100, group: 'protocol', paranoia: 1, severity: 5, targets: ['raw_uri', 'args', 'headers'], pattern: String.raw`\x00`, caseless: false, msg: 'Null byte in request' },
  { id: 920110, group: 'protocol', paranoia: 2, severity: 3, targets: ['method'], pattern: '^(?!(?:GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$)', caseless: false, msg: 'Unusual HTTP method' },

  // --- scanners and probes
  {
    id: 913100,
    group: 'scanner',
    paranoia: 1,
    severity: 5,
    targets: ['ua'],
    pattern: String.raw`(?:sqlmap|nikto|nmap scripting engine|masscan|zgrab|nuclei|acunetix|wpscan|dirbuster|gobuster|feroxbuster|\bffuf\b|whatweb|netsparker|havij|w3af|arachni|openvas|jaeles|xray/|commix)`,
    msg: 'Security scanner user agent',
  },
  { id: 913110, group: 'scanner', paranoia: 2, severity: 2, targets: ['ua'], pattern: String.raw`^\s*$`, msg: 'Empty user agent' },

  // --- sensitive files
  { id: 930100, group: 'files', paranoia: 1, severity: 5, targets: ['uri'], pattern: String.raw`/\.(?:git|svn|hg|bzr)(?:/|$)`, msg: 'Version control metadata access' },
  {
    id: 930110,
    group: 'files',
    paranoia: 1,
    severity: 5,
    targets: ['uri'],
    pattern: String.raw`(?:/\.(?:env(?:\.[\w-]+)?|htpasswd|htaccess|DS_Store|npmrc|dockercfg|git-credentials)$|/\.(?:aws|ssh|docker)/|/(?:docker-compose\.ya?ml|wp-config\.php(?:\.\w+)?)$)`,
    msg: 'Secrets or configuration file access',
  },
  { id: 930120, group: 'files', paranoia: 1, severity: 3, targets: ['uri'], pattern: String.raw`(?:\.(?:bak|old|orig|swp|save)|~)$`, msg: 'Backup file access' },
  { id: 930121, group: 'files', paranoia: 2, severity: 3, targets: ['uri'], pattern: String.raw`\.(?:sql|sqlite3?|dump|mdb)$`, msg: 'Database dump access' },
  {
    id: 930130,
    group: 'files',
    paranoia: 1,
    severity: 5,
    targets: ['uri'],
    pattern: String.raw`/(?:phpinfo\.php|server-status|actuator/(?:env|heapdump|gateway|jolokia)|cgi-bin/[^/]*\.(?:sh|pl|cgi))(?:/|$)`,
    msg: 'Probe for a known sensitive endpoint',
  },

  // --- path traversal / local file inclusion
  { id: 930200, group: 'lfi', paranoia: 1, severity: 5, targets: ['raw_uri', 'args', 'cookies'], pattern: TRAVERSAL, msg: 'Path traversal' },
  { id: 930201, group: 'lfi', paranoia: 2, severity: 5, targets: ['body'], pattern: TRAVERSAL, msg: 'Path traversal in request body' },
  {
    id: 930210,
    group: 'lfi',
    paranoia: 1,
    severity: 5,
    targets: ['raw_uri', 'args', 'body', 'cookies'],
    pattern: String.raw`(?:/etc/(?:passwd|shadow|group|sudoers)\b|/proc/(?:self|\d+)/(?:environ|cmdline|maps)\b|\\windows\\(?:system32|win\.ini)|\bboot\.ini\b)`,
    msg: 'Operating system file access',
  },
  { id: 930220, group: 'lfi', paranoia: 1, severity: 5, targets: ['args', 'body', 'cookies'], pattern: String.raw`\b(?:php|zip|phar|expect|glob|data)://`, msg: 'PHP stream wrapper' },

  // --- remote code execution
  { id: 932100, group: 'rce', paranoia: 1, severity: 5, targets: ['args', 'cookies'], pattern: CMD_INJECTION, msg: 'OS command injection' },
  { id: 932101, group: 'rce', paranoia: 2, severity: 5, targets: ['body'], pattern: CMD_INJECTION, msg: 'OS command injection in request body' },
  { id: 932110, group: 'rce', paranoia: 1, severity: 5, targets: ['headers', 'ua', 'referer', 'cookies'], pattern: String.raw`\(\s*\)\s*\{`, caseless: false, msg: 'Shellshock' },
  {
    id: 932120,
    group: 'rce',
    paranoia: 1,
    severity: 5,
    targets: ['raw_uri', 'args', 'body', 'cookies', 'headers', 'ua', 'referer'],
    pattern: String.raw`\$\{(?:jndi:|(?:lower|upper|env|sys|java|date|base64):|::-|\$\{)`,
    msg: 'Log4Shell / JNDI lookup',
  },
  { id: 932130, group: 'rce', paranoia: 1, severity: 5, targets: ['args', 'cookies'], pattern: PHP_CODE, msg: 'PHP code injection' },
  { id: 932131, group: 'rce', paranoia: 2, severity: 5, targets: ['body'], pattern: PHP_CODE, msg: 'PHP code injection in request body' },
  { id: 932140, group: 'rce', paranoia: 1, severity: 5, targets: ['args', 'body', 'cookies'], pattern: String.raw`\bclass\.(?:module\.)?classloader\b`, msg: 'Spring4Shell class loader manipulation' },

  // --- SQL injection
  { id: 942100, group: 'sqli', paranoia: 1, severity: 5, targets: ['args', 'cookies'], pattern: UNION_SELECT, msg: 'SQL injection: UNION SELECT' },
  { id: 942101, group: 'sqli', paranoia: 2, severity: 5, targets: ['body'], pattern: UNION_SELECT, msg: 'SQL injection in request body: UNION SELECT' },
  {
    id: 942110,
    group: 'sqli',
    paranoia: 1,
    severity: 5,
    targets: ['args', 'cookies'],
    pattern: String.raw`['"` + '`' + String.raw`]\s*(?:or|and|xor|\|\||&&)\s+['"` + '`' + String.raw`]?[\w-]+['"` + '`' + String.raw`]?\s*(?:=|<|>|like\b|is\b)`,
    msg: 'SQL injection: tautology',
  },
  {
    id: 942120,
    group: 'sqli',
    paranoia: 2,
    severity: 4,
    targets: ['args', 'cookies'],
    pattern: String.raw`['"` + '`' + String.raw`]\s*(?:;|--(?:\s|$)|#|/\*)`,
    msg: 'SQL injection: quote followed by a terminator',
  },
  { id: 942130, group: 'sqli', paranoia: 1, severity: 5, targets: ['args', 'cookies'], pattern: SQL_FUNCS, msg: 'SQL injection: time-based or schema probing' },
  { id: 942131, group: 'sqli', paranoia: 2, severity: 5, targets: ['body'], pattern: SQL_FUNCS, msg: 'SQL injection in request body: time-based or schema probing' },
  {
    id: 942140,
    group: 'sqli',
    paranoia: 2,
    severity: 5,
    targets: ['args', 'cookies'],
    pattern: String.raw`;\s*(?:drop|truncate|alter|create|insert|update|delete|exec)\s+(?:table|database|from|into|procedure|\w+\s+set)\b`,
    msg: 'SQL injection: stacked query',
  },

  // --- cross-site scripting
  { id: 941100, group: 'xss', paranoia: 1, severity: 5, targets: ['args', 'cookies', 'referer'], pattern: SCRIPT_TAG, msg: 'XSS: script tag' },
  { id: 941101, group: 'xss', paranoia: 2, severity: 5, targets: ['body'], pattern: SCRIPT_TAG, msg: 'XSS in request body: script tag' },
  { id: 941110, group: 'xss', paranoia: 1, severity: 5, targets: ['args', 'cookies', 'referer'], pattern: EVENT_HANDLER, msg: 'XSS: event handler attribute' },
  { id: 941111, group: 'xss', paranoia: 2, severity: 5, targets: ['body'], pattern: EVENT_HANDLER, msg: 'XSS in request body: event handler attribute' },
  { id: 941120, group: 'xss', paranoia: 1, severity: 5, targets: ['args', 'cookies'], pattern: String.raw`\b(?:javascript|vbscript|livescript)\s*:`, msg: 'XSS: script URI scheme' },
  { id: 941130, group: 'xss', paranoia: 2, severity: 3, targets: ['args'], pattern: String.raw`<(?:iframe|object|embed|svg|math|base|meta|link|style)\b`, msg: 'XSS: dangerous HTML element' },
  {
    id: 941140,
    group: 'xss',
    paranoia: 2,
    severity: 3,
    targets: ['args', 'cookies'],
    pattern: String.raw`(?:document\.(?:cookie|domain|write)|window\.location|\b(?:alert|prompt|confirm)\s*\(|String\.fromCharCode)`,
    msg: 'XSS: JavaScript payload',
  },

  // --- server-side request forgery
  {
    id: 934100,
    group: 'ssrf',
    paranoia: 1,
    severity: 5,
    targets: ['args', 'body', 'cookies'],
    pattern: String.raw`(?:169\.254\.169\.254|metadata\.google\.internal|100\.100\.100\.200|fd00:ec2::254)`,
    msg: 'SSRF: cloud metadata endpoint',
  },
  { id: 934110, group: 'ssrf', paranoia: 1, severity: 5, targets: ['args'], pattern: String.raw`\b(?:gopher|dict|ldap|jar|tftp)://`, msg: 'SSRF: dangerous URL scheme' },

  // --- Java
  {
    id: 944100,
    group: 'java',
    paranoia: 1,
    severity: 5,
    targets: ['args', 'body', 'cookies', 'headers'],
    pattern: String.raw`(?:rO0AB|aced0005|java\.lang\.(?:Runtime|ProcessBuilder))`,
    caseless: false,
    msg: 'Java deserialization / runtime access',
  },
];

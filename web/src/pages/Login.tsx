import { useState } from 'preact/hooks';
import { browserSupportsWebAuthn, startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { api, authState, post, type AuthStatus } from '../api';
import { LANGS, lang, setLang, t, type Lang } from '../i18n';
import { Button } from '../components/ui';

/** Passkey-only login. The first passkey requires the setup token from the server log / env. */
export function Login({ status }: { status: AuthStatus }) {
  const [setupToken, setSetupToken] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const supported = browserSupportsWebAuthn();

  const done = async () => (authState.value = await api<AuthStatus>('/auth/status'));

  const register = async () => {
    setError('');
    try {
      const optionsJSON = await post('/auth/register/options', { setupToken, name });
      const response = await startRegistration({ optionsJSON });
      await post('/auth/register/verify', { response });
      await done();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const login = async () => {
    setError('');
    try {
      const optionsJSON = await post('/auth/login/options');
      const response = await startAuthentication({ optionsJSON });
      await post('/auth/login/verify', { response });
      await done();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div class="login">
      <div class="login-card">
        <div class="brand big">
          <span class="brand-mark">V</span>
          <span>VAS</span>
        </div>
        <p class="muted">{t('login.subtitle')}</p>
        {!supported && <div class="alert alert-error">{t('login.unsupported')}</div>}
        {status.needsSetup ? (
          <>
            <h2>{t('login.setupTitle')}</h2>
            <p class="muted small">{t('login.setupHint')}</p>
            <label class="field">
              <span class="field-label">{t('login.setupToken')}</span>
              <input class="input mono" value={setupToken} onInput={(e) => setSetupToken((e.target as HTMLInputElement).value)} />
            </label>
            <label class="field">
              <span class="field-label">{t('login.passkeyName')}</span>
              <input class="input" value={name} placeholder="YubiKey / iPhone" onInput={(e) => setName((e.target as HTMLInputElement).value)} />
            </label>
            <Button variant="primary" onClick={register} disabled={!supported || !setupToken}>
              {t('login.register')}
            </Button>
          </>
        ) : (
          <Button variant="primary" onClick={login} disabled={!supported}>
            {t('login.signIn')}
          </Button>
        )}
        {error && <div class="alert alert-error">{error}</div>}
        <select class="input input-sm" value={lang.value} onChange={(e) => setLang((e.target as HTMLSelectElement).value as Lang)}>
          {LANGS.map((l) => (
            <option key={l.code} value={l.code}>
              {l.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

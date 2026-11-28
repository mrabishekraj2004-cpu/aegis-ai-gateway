import { createAuthClient } from "@neon/auth";

const show = (node, visible) => { node.hidden = !visible; };
const errorText = error => error?.message ?? error?.error?.message ?? "Check your details and try again.";

export function createManagedAuth(config = {}) {
  const authUrl = typeof config.neonAuthUrl === "string" ? config.neonAuthUrl : "";
  const client = authUrl ? createAuthClient(authUrl) : null;
  let session = null;
  let challenge = null;

  async function restore() {
    if (!client) return null;
    const result = await client.getSession();
    session = result?.data?.session ?? null;
    return session;
  }

  async function accessToken() {
    if (!client) return null;
    const current = await client.getSession();
    session = current?.data?.session ?? null;
    return session?.token ?? null;
  }

  function install({ getView, setView, setStatus, showNotice, applyProfile, navigatePage }) {
    if (!client) return;
    const form = document.querySelector("#auth-form");
    const emailInput = document.querySelector("#auth-email");
    const otpInput = document.querySelector("#auth-otp");
    const passwordInput = document.querySelector("#auth-password");
    const newPasswordInput = document.querySelector("#auth-new-password");
    const submit = document.querySelector("#auth-submit");

    const notice = message => { showNotice(message); setStatus(message); };
    const setChallenge = ({ type, email, password = null }) => {
      challenge = { type, email, password };
      document.querySelector("#auth-name-field").hidden = true;
      document.querySelector("#auth-terms").hidden = true;
      document.querySelector("#auth-password-field").hidden = true;
      document.querySelector("#auth-otp-field").hidden = false;
      document.querySelector("#auth-new-password-field").hidden = type !== "password-reset";
      otpInput.required = true;
      otpInput.value = "";
      newPasswordInput.required = type === "password-reset";
      newPasswordInput.value = "";
      document.querySelector("#auth-title").textContent = type === "password-reset" ? "Reset password" : "Verify your email";
      document.querySelector("#auth-copy").textContent = type === "password-reset"
        ? `Enter the code sent to ${email} and choose a new password.`
        : `Enter the six-digit code sent to ${email} to verify your account.`;
      submit.textContent = type === "password-reset" ? "Reset password" : "Verify email";
      document.querySelector("#auth-notice").hidden = true;
      requestAnimationFrame(() => otpInput.focus());
    };

    const finishSignIn = async () => {
      const current = await restore();
      if (!current?.token) throw new Error("Your email was verified. Sign in to continue to the workspace.");
      const user = current.user ?? {};
      applyProfile({ name: user.name ?? "Aegis Operator", email: user.email ?? "" });
      setStatus("Signed in. Opening your workspace.");
      const next = new URL(window.location.href);
      if (config.apiBaseUrl) next.searchParams.set("mode", "api");
      next.hash = "overview";
      window.location.assign(next.href);
    };

    form.addEventListener("submit", async event => {
      if (!client) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!form.reportValidity()) return;
      const email = emailInput.value.trim().toLowerCase();
      const password = passwordInput.value;
      submit.disabled = true;
      try {
        if (challenge?.type === "email-verification") {
          const result = await client.emailOtp.verifyEmail({ email: challenge.email, otp: otpInput.value.trim() });
          if (result?.error) throw result.error;
          challenge = null;
          await finishSignIn();
          return;
        }
        if (challenge?.type === "password-reset") {
          const result = await client.emailOtp.resetPassword({ email: challenge.email, otp: otpInput.value.trim(), password: newPasswordInput.value });
          if (result?.error) throw result.error;
          challenge = null;
          setView("login");
          notice("Password updated. Sign in with your new password.");
          return;
        }

        const view = getView();
        if (view === "register") {
          const result = await client.signUp.email({ email, password, name: document.querySelector("#auth-name").value.trim(), callbackURL: window.location.origin });
          if (result?.error) throw result.error;
          setChallenge({ type: "email-verification", email, password });
          notice(`A verification code was sent to ${email}.`);
          return;
        }
        if (view === "forgot-password") {
          const result = await client.forgetPassword.emailOtp({ email });
          if (result?.error) throw result.error;
          setChallenge({ type: "password-reset", email });
          notice(`If an account exists for ${email}, a password reset code is on its way.`);
          return;
        }

        const result = await client.signIn.email({ email, password });
        if (result?.error) {
          const code = result.error.code ?? result.error.error?.code;
          if (code === "EMAIL_NOT_VERIFIED" || code === "email_not_verified") {
            const sent = await client.emailOtp.sendVerificationOtp({ email, type: "email-verification" });
            if (sent?.error) throw sent.error;
            setChallenge({ type: "email-verification", email });
            notice(`Verify your email first. A new code was sent to ${email}.`);
            return;
          }
          throw result.error;
        }
        await finishSignIn();
      } catch (error) {
        notice(errorText(error));
      } finally {
        submit.disabled = false;
      }
    }, true);

    const profileForm = document.querySelector("#profile-form");
    profileForm.addEventListener("submit", async event => {
      if (!session) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const name = document.querySelector("#profile-name").value.trim();
      const save = document.querySelector("#save-profile-button");
      save.disabled = true;
      try {
        const result = await client.updateUser({ name });
        if (result?.error) throw result.error;
        const user = result?.data?.user ?? session.user ?? {};
        applyProfile({ name: user.name ?? name, email: user.email ?? session.user?.email ?? "" });
        document.querySelector("#profile-save-note").textContent = "Profile saved to your account.";
        setStatus("Profile saved to your account.");
      } catch (error) {
        document.querySelector("#profile-save-note").textContent = errorText(error);
        setStatus(`Profile could not be saved. ${errorText(error)}`);
      } finally { save.disabled = false; }
    }, true);

    document.querySelector("#sign-out-button")?.addEventListener("click", async () => {
      try {
        await client.signOut();
        session = null;
        const next = new URL(window.location.href);
        if (config.apiBaseUrl) next.searchParams.set("mode", "api");
        next.hash = "login";
        window.location.assign(next.href);
      } catch (error) { setStatus(`Sign out failed. ${errorText(error)}`); }
    });

    document.addEventListener("click", event => {
      if (event.target.closest("[data-auth]")) challenge = null;
    }, true);
  }

  return { enabled: Boolean(client), restore, accessToken, install };
}

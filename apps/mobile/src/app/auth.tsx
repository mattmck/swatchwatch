import { Redirect } from "expo-router";

/**
 * Landing route for the OAuth redirect URI `swatchwatch://auth`. expo-auth-session reads the
 * result itself; on Android the redirect also arrives as an app link, so this route exists
 * only to send it home instead of showing "Unmatched Route".
 */
export default function AuthRedirect() {
  return <Redirect href="/" />;
}

const MOBILE_UA =
  /Android|iPhone|iPod|iPad|Mobile|Opera Mini|IEMobile|Windows Phone|BlackBerry/i;

export default async function middleware(req) {
  const url = new URL(req.url);
  const ua = req.headers.get("user-agent") || "";
  if (url.pathname === "/" && MOBILE_UA.test(ua)) {
    const page = await fetch(new URL("/mobile.html", url));
    return new Response(page.body, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
}

export const config = { matcher: ["/"] };

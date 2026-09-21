# Relay مستقل تلگرام برای WCTSP

این نسخه برای هاست‌هایی ساخته شده که از داخل سرور اجازه اتصال HTTP/HTTPS مناسب به Telegram/Cloudflare را نمی‌دهند.

## مسیر جدید

Telegram -> Cloudflare Worker -> WordPress
WordPress -> صف داخلی -> Cloudflare Worker (هر دقیقه) -> Telegram

در حالت مستقل، WordPress هیچ درخواست خروجی به Worker برای پاسخ‌های ربات ارسال نمی‌کند.

## متغیرهای Worker

### Secret
`RELAY_SECRET`

باید دقیقاً همان Secret باشد که در افزونه WordPress در بخش «اتصال و Relay» وارد شده است.

### Variable (اختیاری)
`WP_BASE_URL`

پیش‌فرض: `https://podl.fun`
اگر سایت تغییر کرد، این متغیر را با آدرس اصلی سایت عوض کنید.

### Variable (اختیاری)
`WORKER_HOST`

پیش‌فرض: `telegram-relay.pouyak6666601.workers.dev`
فقط اگر دامنه Worker تغییر کرد تنظیم شود.

## Cron

Cron روی `* * * * *` تنظیم شده تا صف خروجی را هر دقیقه پردازش کند. Cloudflare Cron Trigger را در بخش Settings > Triggers > Cron Triggers بررسی کنید.

## بعد از Deploy

1. Secret قبلی `RELAY_SECRET` را پاک نکنید و تغییر ندهید.
2. اگر `WP_BASE_URL` ندارید، لازم نیست بسازید؛ پیش‌فرض `https://podl.fun` است.
3. یک بار این آدرس را باز کنید:
   `/health`
4. سپس `/ping` باید پاسخ `pong: true` بدهد.
5. در افزونه حالت «Relay مستقل» را فعال و ذخیره کنید.
6. Token ربات و `RELAY_SECRET` باید در افزونه موجود باشند.

Worker خودش Webhook تلگرام را به `/telegram-webhook` تنظیم می‌کند.

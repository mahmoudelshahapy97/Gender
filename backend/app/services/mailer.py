# app/services/mailer.py
"""Outgoing mail over SMTP, for password-reset codes and notifications.

smtplib blocks, so callers go through ``send``, which runs it on a thread.
One connection carries every message of a call: a notification mailed to ten
accounts is one login, not ten.
"""

import asyncio
import smtplib
from email.message import EmailMessage
from typing import Iterable, List

from app.core.config import config


def message(to: str, subject: str, text: str, html: str) -> EmailMessage:
    mail = EmailMessage()
    mail["Subject"] = subject
    mail["From"] = config.smtp_from
    mail["To"] = to
    mail.set_content(text)
    mail.add_alternative(html, subtype="html")
    return mail


def _send_blocking(messages: List[EmailMessage]) -> None:
    smtp_cls = smtplib.SMTP_SSL if config.smtp_ssl else smtplib.SMTP
    with smtp_cls(config.smtp_host, config.smtp_port, timeout=config.smtp_timeout_seconds) as smtp:
        if config.smtp_starttls and not config.smtp_ssl:
            smtp.starttls()
        if config.smtp_username:
            smtp.login(config.smtp_username, config.smtp_password)
        for mail in messages:
            smtp.send_message(mail)


async def send(messages: Iterable[EmailMessage]) -> None:
    """Raises on failure; the callers run in the background and log it."""
    batch = list(messages)
    if batch:
        await asyncio.to_thread(_send_blocking, batch)

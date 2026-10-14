// Waitlist forms: post to the configured endpoint, or open the hosted form. No trackers.
;(() => {
  const config = window.AFTERHOURS || {}

  const contact = document.querySelector('[data-contact]')
  if (contact && config.contactEmail) {
    const link = document.createElement('a')
    link.href = `mailto:${config.contactEmail}`
    link.textContent = config.contactEmail
    contact.append('Questions? ', link)
  }

  for (const form of document.querySelectorAll('[data-waitlist]')) {
    const note = form.querySelector('[data-form-note]')
    const button = form.querySelector('button')
    const input = form.querySelector('input[type=email]')
    const say = (text, kind) => {
      note.textContent = text
      note.className = `form-note ${kind}`
    }

    form.addEventListener('submit', async event => {
      event.preventDefault()
      const email = input.value.trim()
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        say('Please enter a valid email address.', 'err')
        input.focus()
        return
      }
      if (!config.waitlistEndpoint) {
        if (config.waitlistUrl) {
          const url = new URL(config.waitlistUrl)
          url.searchParams.set('email', email)
          window.open(url, '_blank', 'noopener')
          say('The waitlist form opened in a new tab.', 'ok')
        } else {
          say('The waitlist opens soon. Please check back in a few days.', 'err')
        }
        return
      }
      button.disabled = true
      try {
        const body = new FormData()
        body.append('email', email)
        body.append('source', location.pathname + (form.id ? `#${form.id}` : ''))
        const res = await fetch(config.waitlistEndpoint, { method: 'POST', body, headers: { Accept: 'application/json' } })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        form.reset()
        say("You're on the list. One email when your invite is ready.", 'ok')
      } catch {
        say('That didn’t go through. Please try again in a moment.', 'err')
      } finally {
        button.disabled = false
      }
    })
  }
})()

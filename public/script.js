document.addEventListener('DOMContentLoaded', () => {
    console.log('shvm-db loaded');

    // 1. Highlight Active Header Link
    const currentPath = window.location.pathname;
    document.querySelectorAll('.links a').forEach(link => {
        const href = link.getAttribute('href');
        // Simple match: if href matches path (e.g. /docs.html)
        if (href === currentPath) {
            link.classList.add('active');
        } else if (currentPath === '/' && (href === '/' || href.startsWith('/#'))) {
            // Home page logic can be tricky with hash links
            // For now, if exact match '/' set active
            if (href === '/') link.classList.add('active');
        }
    });

    // 2. Smooth Scroll for Anchor Links (Enhanced)
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', function (e) {
            const targetId = this.getAttribute('href');
            if (targetId === '#') return;

            const targetElement = document.querySelector(targetId);
            if (targetElement) {
                e.preventDefault();
                targetElement.scrollIntoView({
                    behavior: 'smooth'
                });
                // Update URL hash without jump
                history.pushState(null, null, targetId);
            }
        });
    });

    // 3. Sidebar ScrollSpy (IntersectionObserver)
    const sections = document.querySelectorAll('section[id]');
    const navLinks = document.querySelectorAll('.docs-sidebar a');

    if (sections.length > 0 && navLinks.length > 0) {
        const observerOptions = {
            root: null,
            rootMargin: '-100px 0px -60% 0px', // Activate when section enters top part of screen
            threshold: 0.1
        };

        const observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    // Remove active from all
                    navLinks.forEach(link => link.classList.remove('active'));
                    // Add active to current
                    const id = entry.target.getAttribute('id');
                    const activeLink = document.querySelector(`.docs-sidebar a[href="#${id}"]`);
                    if (activeLink) {
                        activeLink.classList.add('active');
                        // Also sync header active state if needed? No, sidebar is specific.
                    }
                }
            });
        }, observerOptions);

        sections.forEach(section => observer.observe(section));
    }
});

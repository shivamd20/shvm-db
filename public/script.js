document.addEventListener('DOMContentLoaded', () => {
    console.log('shvm-db homepage loaded');

    // Smooth scrolling for anchor links
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', function (e) {
            e.preventDefault();
            document.querySelector(this.getAttribute('href')).scrollIntoView({
                behavior: 'smooth'
            });
        });
    });

    // Simple interaction: Hover effect on hero text
    const heroTitle = document.querySelector('h1');
    heroTitle.addEventListener('mouseover', () => {
        heroTitle.style.transform = 'scale(1.02)';
        heroTitle.style.transition = 'transform 0.3s ease';
    });

    heroTitle.addEventListener('mouseout', () => {
        heroTitle.style.transform = 'scale(1)';
    });
});

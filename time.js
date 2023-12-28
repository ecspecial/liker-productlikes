const getCurrentDateInMoscow = async () => {
    const now = new Date();
    console.log(now);
    const moscowOffset = 3 * 60 * 60000; // МОСКВВА UTC+3
    console.log(moscowOffset);
    return new Date(now.getTime() + moscowOffset);
}

(async () => {
    console.log(await getCurrentDateInMoscow());
})()
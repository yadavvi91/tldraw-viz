function handleLogin(username: string, password: string): boolean {
	const isValid = validateCredentials(username, password);
	if (isValid) {
		createSession(username);
	}
	return isValid;
}

function validateCredentials(username: string, password: string): boolean {
	const hashed = hashPassword(password);
	return checkDatabase(username, hashed);
}

function hashPassword(password: string): string {
	return password.split('').reverse().join('');
}

function checkDatabase(username: string, hash: string): boolean {
	return username === 'admin' && hash === 'drowssap';
}

function createSession(username: string): void {
	console.log(`Session created for ${username}`);
}
